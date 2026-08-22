import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ShellKind = 'bash' | 'powershell';

// Marker appended to every command so we can recover its real exit code and
// strip the terminal echo/prompt noise from the captured output
const EXIT_MARKER = '__MCP_EXIT';

/**
 * Detects which family of shell the terminal is running so the cd prefix and
 * exit-code capture use valid syntax (PowerShell 5.1 rejects `&&` chains)
 * @param terminal The terminal to inspect
 */
export function detectShellKind(terminal: vscode.Terminal): ShellKind {
    const options: any = (terminal as any).creationOptions || {};
    let shellPath = options.shellPath;
    if (shellPath && typeof shellPath !== 'string') {
        shellPath = shellPath.path;
    }
    if (!shellPath && terminal.name) {
        shellPath = terminal.name;
    }
    const asString = String(shellPath || '');
    if (/powershell|pwsh|cmd/i.test(asString)) {
        return 'powershell';
    }
    if (/bash|sh|zsh|wsl|git/i.test(asString)) {
        return 'bash';
    }
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

function toBashPath(p: string): string {
    // Git Bash accepts drive-letter forward-slash form (D:/path) but not backslashes
    return p.replace(/\\/g, '/');
}

function toPosixQuoted(p: string): string {
    return `"${toBashPath(p)}"`;
}

function toPowerShellQuoted(p: string): string {
    return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Builds the command handed to the terminal: cwd prefix adapted to the shell,
 * plus the exit-code marker used to recover the command's real exit status
 * @param terminal The terminal the command will run in
 * @param command The user command
 * @param cwd Optional working directory
 */
export function buildFullCommand(terminal: vscode.Terminal, command: string, cwd?: string): string {
    const kind = detectShellKind(terminal);
    let prefixed = command;
    if (cwd && cwd !== '.' && cwd !== './') {
        prefixed = kind === 'bash'
            ? `cd ${toPosixQuoted(cwd)} && ${command}`
            : `Set-Location ${toPowerShellQuoted(cwd)}; ${command}`;
    }
    return kind === 'bash'
        ? `${prefixed}; echo "${EXIT_MARKER}:$?"`
        : `${prefixed}; Write-Output "${EXIT_MARKER}:$LASTEXITCODE"`;
}

/**
 * Waits briefly for shell integration to become available
 * @param terminal The terminal to wait for
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves to true if shell integration became available
 */
export async function waitForShellIntegration(terminal: vscode.Terminal, timeout = 5000): Promise<boolean> {
    if (terminal.shellIntegration) {
        return true;
    }

    return new Promise<boolean>(resolve => {
        const timeoutId = setTimeout(() => {
            disposable.dispose();
            resolve(false);
        }, timeout);

        const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal === terminal && terminal.shellIntegration) {
                clearTimeout(timeoutId);
                disposable.dispose();
                resolve(true);
            }
        });
    });
}

// Serializes executions per terminal so overlapping calls never interleave
// (a second command typed into a busy session corrupts both)
const terminalQueues = new WeakMap<vscode.Terminal, Promise<unknown>>();

function queueOnTerminal<T>(terminal: vscode.Terminal, task: () => Promise<T>): Promise<T> {
    const prev = terminalQueues.get(terminal) || Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    terminalQueues.set(terminal, run);
    return run;
}

async function executeAndWait(terminal: vscode.Terminal, fullCommand: string, timeout: number): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        // The deadline races every read: even a fully silent command gets cut
        // off at the limit instead of hanging the caller
        let hitDeadline: () => void = () => {};
        const deadline = new Promise<null>(res => { hitDeadline = () => res(null); });
        const timer = setTimeout(() => {
            timedOut = true;
            hitDeadline();
        }, timeout);

        void (async () => {
            let outputStream: AsyncIterable<unknown> | undefined;
            try {
                const execution = terminal.shellIntegration!.executeCommand(fullCommand);
                let output = '';
                outputStream = (execution as any).read();
                const reader = (outputStream as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]();
                for (;;) {
                    const chunk = await Promise.race([reader.next(), deadline]);
                    if (chunk === null || chunk.done) {
                        break;
                    }
                    output += chunk.value;
                }

                clearTimeout(timer);

                // Recover the real exit code and strip the marker line plus the
                // echoed command / trailing prompt noise from the captured stream
                let exitCode = 0;
                const lines = output.split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const markerMatch = lines[i].match(new RegExp(`${EXIT_MARKER}:(\\d+)`));
                    if (markerMatch) {
                        exitCode = parseInt(markerMatch[1], 10);
                        lines.splice(i, 1);
                        break;
                    }
                }
                let cleaned = lines
                    .filter(line => !line.includes(fullCommand))
                    .join('\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                if (timedOut) {
                    // 124 is what GNU timeout reports; the process itself keeps
                    // running in the terminal and can finish there later
                    cleaned += `\n\n[Timed out after ${timeout}ms — showing the output captured so far. The process may still be running in the terminal; retry with a larger timeout if you need the rest.]`;
                    resolve({ output: cleaned, exitCode: 124 });
                    return;
                }

                resolve({ output: cleaned, exitCode });
            } catch (error) {
                clearTimeout(timer);
                if (!timedOut) {
                    reject(new Error(`Failed to read command output: ${error instanceof Error ? error.message : String(error)}`));
                } else {
                    // stream died during a timeout: still better than nothing
                    resolve({ output: '', exitCode: 124 });
                }
            } finally {
                // best-effort: end a stream still open after a timeout so the
                // reader doesn't keep accumulating output forever
                try {
                    await (outputStream as any)?.return?.();
                } catch {
                }
            }
        })();
    });
}

/**
 * Executes a shell command using terminal shell integration
 * @param terminal The terminal with shell integration
 * @param command The command to execute
 * @param cwd Optional working directory for the command
 * @param timeout Command timeout in milliseconds (default: 10000)
 * @returns Promise that resolves with the command output and its real exit code
 */
export async function executeShellCommand(
    terminal: vscode.Terminal,
    command: string,
    cwd?: string,
    timeout: number = 10000
): Promise<{ output: string; exitCode: number }> {
    if (!terminal.shellIntegration) {
        const available = await waitForShellIntegration(terminal);
        if (!available || !terminal.shellIntegration) {
            throw new Error('Shell integration not available in terminal');
        }
    }

    const fullCommand = buildFullCommand(terminal, command, cwd);
    terminal.show();

    return queueOnTerminal(terminal, () => executeAndWait(terminal, fullCommand, timeout));
}

/**
 * Registers MCP shell-related tools with the server
 * @param server MCP server instance
 * @param terminal The terminal to use for command execution
 */
export function registerShellTools(server: McpServer, terminal?: vscode.Terminal): void {
    // Add execute_shell_command tool
    server.tool(
        'execute_shell_command_code',
        `Executes shell commands in VS Code integrated terminal.

        WHEN TO USE: Running CLI commands, builds, git operations, npm/pip installs.

        Working directory: Use cwd to run commands in specific directories. Defaults to workspace root. If you get unexpected results, ensure the cwd is correct.

        Timeout: A command that exceeds its time limit (default 10s) returns the output captured so far with exit code 124 and a note; the process keeps running in the terminal. Slow scans or installs need a larger timeout passed explicitly.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Optional working directory for the command'),
            timeout: z.number().optional().default(10000).describe('Command timeout in milliseconds (default: 10000)')
        },
        async ({ command, cwd, timeout = 10000 }): Promise<CallToolResult> => {
            try {
                if (!terminal) {
                    throw new Error('Terminal not available');
                }

                const { output, exitCode } = await executeShellCommand(terminal, command, cwd, timeout);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Command: ${command}\nExit code: ${exitCode}\n\nOutput:\n${output}`
                        }
                    ]
                };
                return result;
            } catch (error) {
                console.error('[execute_shell_command] Error in tool:', error);
                throw error;
            }
        }
    );
}
