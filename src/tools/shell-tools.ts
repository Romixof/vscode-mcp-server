import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, resolveInputPath, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

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
    if (/powershell|pwsh|\bcmd\b/i.test(asString)) {
        return 'powershell';
    }
    // Word boundaries: "MCP Shell Commands" must not read as sh and push POSIX
    // syntax into a PowerShell terminal
    if (/\b(?:bash|zsh|sh|wsl|fish|dash|ksh)\b|git\s*bash/i.test(asString)) {
        return 'bash';
    }
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

function toBashPath(p: string): string {
    // Git Bash accepts drive-letter forward-slash form (D:/path) but not backslashes
    return p.replace(/\\/g, '/');
}

function toPosixQuoted(p: string): string {
    return `'${toBashPath(p).replace(/'/g, `'\\''`)}'`;
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
    const wantsCd = !!cwd && cwd !== '.' && cwd !== './';
    if (kind === 'bash') {
        const body = wantsCd ? `cd ${toPosixQuoted(cwd!)} && ${command}` : command;
        // Marker on its own line: appended after a trailing "# comment" it
        // would become part of that comment and failures would read as exit 0
        return `${body}\necho "${EXIT_MARKER}:$?"`;
    }
    // The whole template runs inside a script block so our variables stay
    // scoped to it instead of leaking into the user's session; $LASTEXITCODE
    // stays readable because the marker line sits inside the block too
    const lines = ['& {', '$ok = $true'];
    if (wantsCd) {
        // ';' would run the command anyway after a failed cd, landing it in
        // whatever directory the terminal happened to sit in
        lines.push(`Set-Location ${toPowerShellQuoted(cwd!)}`, '$ok = $?');
    }
    // Braces on their own lines: a trailing "# comment" in the user command
    // must not be able to swallow the closing brace of an if on one line
    lines.push('if ($ok) {');
    lines.push(command);
    lines.push('}');
    // Cmdlets never set $LASTEXITCODE, so $? covers what it leaves behind
    const rc = '$(if (-not $ok) { 1 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })';
    lines.push(`Write-Output "${EXIT_MARKER}:${rc}"`);
    lines.push('}');
    return lines.join('\n');
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
                // echoed command / trailing prompt noise from the captured stream.
                // Last match per line wins: a printed marker-shaped string must
                // not shadow the real reading
                let exitCode = 0;
                const lines = output.split('\n');
                const markerRegex = new RegExp(`${EXIT_MARKER}:(\\d+)`, 'g');
                for (let i = lines.length - 1; i >= 0; i--) {
                    let markerMatch: RegExpExecArray | null = null;
                    let m: RegExpExecArray | null;
                    while ((m = markerRegex.exec(lines[i])) !== null) {
                        markerMatch = m;
                    }
                    markerRegex.lastIndex = 0;
                    if (markerMatch) {
                        exitCode = parseInt(markerMatch[1], 10);
                        lines.splice(i, 1);
                        break;
                    }
                }
                // Commands now span several lines (cd guard, braces, exit
                // marker), so their echo comes back row by row instead of as
                // one string; rows of two chars or less ("}", "& {") are kept —
                // JSON output legitimately contains them and they carry no echo
                const templateLines = new Set(
                    fullCommand.split('\n').map(l => l.trim()).filter(l => l.length > 2)
                );
                let cleaned = lines
                    .filter(line => {
                        const trimmed = line.trim();
                        if (trimmed !== '' && templateLines.has(trimmed)) {
                            return false;
                        }
                        return !line.includes(fullCommand);
                    })
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
        Multi-root: pass workspace to anchor cwd against that folder (name or 1-based index).

        Timeout: A command that exceeds its time limit (default 10s) returns the output captured so far with exit code 124 and a note; the process keeps running in the terminal. Slow scans or installs need a larger timeout passed explicitly.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Optional working directory for the command'),
            timeout: z.number().optional().default(10000).describe('Command timeout in milliseconds (default: 10000)'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ command, cwd, timeout = 10000, workspace }): Promise<CallToolResult> => {
            try {
                if (!terminal) {
                    throw new Error('Terminal not available');
                }

                // Without a workspace ref the raw cwd is kept so '.' keeps
                // following the terminal's own persisted directory
                let fullCwd = cwd;
                if (workspace !== undefined && workspace.trim() !== '') {
                    fullCwd = path.resolve(resolveWorkspaceFolder(workspace).uri.fsPath, cwd ?? '.');
                } else if (cwd && cwd !== '.' && cwd !== './' && listWorkspaceFolders().length > 1) {
                    // A "Beta/tools" style cwd picks its folder by name, same
                    // rule as every other path parameter; bare names stay
                    // relative to wherever the terminal sits
                    const segments = cwd.trim().split(/[\\/]+/).filter(s => s !== '' && s !== '.');
                    const hit =
                        segments.length > 1 &&
                        listWorkspaceFolders().some(
                            f => f.name.normalize('NFC').toLowerCase() === segments[0].normalize('NFC').toLowerCase()
                        );
                    if (hit) {
                        fullCwd = resolveInputPath(cwd).fsPath;
                    }
                }

                const { output, exitCode } = await executeShellCommand(terminal, command, fullCwd, timeout);

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
