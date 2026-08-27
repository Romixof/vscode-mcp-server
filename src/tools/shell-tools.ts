import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, resolveInputPath, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { logger } from '../utils/logger';
import { checkShellCommand } from '../auth/shellguard';
import { appendAudit } from '../auth/audit';
import { currentScopes } from '../auth/toolgate';
import { notifyDashboard } from '../dashboard';

export type ShellKind = 'bash' | 'powershell';

const EXIT_MARKER = '__MCP_EXIT';

function matchShellKind(text: string): ShellKind | undefined {
    if (/powershell|pwsh|\bcmd\b/i.test(text)) {
        return 'powershell';
    }

    if (/\b(?:bash|zsh|sh|wsl|fish|dash|ksh)\b|git\s*bash/i.test(text)) {
        return 'bash';
    }
    return undefined;
}

function explicitShellKind(terminal: vscode.Terminal): ShellKind | undefined {
    const options: any = (terminal as any).creationOptions || {};
    let shellPath = options.shellPath;
    if (shellPath && typeof shellPath !== 'string') {
        shellPath = shellPath.path;
    }
    if (shellPath) {
        const fromPath = matchShellKind(String(shellPath));
        if (fromPath) {
            return fromPath;
        }
    }
    if (terminal.name) {
        return matchShellKind(terminal.name);
    }
    return undefined;
}

function shellHints(): string[] {
    const hints: string[] = [];
    const envShell = (vscode.env as { shell?: string }).shell;
    if (envShell) {
        hints.push(envShell);
    }
    try {
        const config = vscode.workspace.getConfiguration('terminal');

        const profileKey =
            process.platform === 'win32' ? 'integrated.defaultProfile.windows' :
            process.platform === 'darwin' ? 'integrated.defaultProfile.osx' :
            'integrated.defaultProfile.linux';
        const profile = config.get<string>(profileKey);
        if (profile) {
            hints.push(profile);
        }
    } catch {

    }
    return hints;
}

export function detectShellKind(terminal: vscode.Terminal): ShellKind {

    const verified = verifiedShellKinds.get(terminal);
    if (verified) {
        return verified;
    }

    const forced = forcedShellKinds.get(terminal);
    if (forced) {
        return forced;
    }
    const explicit = explicitShellKind(terminal);
    if (explicit) {
        return explicit;
    }
    for (const hint of shellHints()) {
        const fromHint = matchShellKind(hint);
        if (fromHint) {
            return fromHint;
        }
    }
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

const verifiedShellKinds = new WeakMap<vscode.Terminal, ShellKind>();

function probeCommand(): string {
    return 'printf \'__MCP_SHELL:%s\\n\' "${BASH_VERSION:-none}"';
}

function powerShellProbeCommand(): string {
    return 'Write-Output "__MCP_PS:$($PSVersionTable.PSVersion.Major)"';
}

export async function resolveShellKind(terminal: vscode.Terminal): Promise<ShellKind> {
    if (!terminal.shellIntegration) {
        const available = await waitForShellIntegration(terminal);
        if (!available || !terminal.shellIntegration) {

            return detectShellKind(terminal);
        }
    }
    return queueOnTerminal(terminal, () => verifyShellKind(terminal));
}

async function verifyShellKind(terminal: vscode.Terminal): Promise<ShellKind> {
    const cached = verifiedShellKinds.get(terminal);
    if (cached) {
        return cached;
    }
    let kind = detectShellKind(terminal);

    if (!explicitShellKind(terminal)) {
        try {
            let { output } = await executeAndWait(terminal, probeCommand(), 2000);
            if (!/__MCP_SHELL:(none|\d)/.test(output)) {

                const ps = await executeAndWait(terminal, powerShellProbeCommand(), 2000);
                output = ps.output;
            }
            if (/__MCP_SHELL:(none|\d)/.test(output)) {
                kind = 'bash';
                verifiedShellKinds.set(terminal, kind);
            } else if (/__MCP_PS:\d/.test(output)) {

                kind = 'powershell';
                verifiedShellKinds.set(terminal, kind);
            }

        } catch {

        }
    }
    return kind;
}

function toBashPath(p: string): string {

    return p.replace(/\\/g, '/');
}

function toPosixQuoted(p: string): string {
    return `'${toBashPath(p).replace(/'/g, `'\\''`)}'`;
}

function toPowerShellQuoted(p: string): string {
    return `'${p.replace(/'/g, "''")}'`;
}

function encodeMultiline(kind: ShellKind, command: string): string {
    if (!command.includes('\n') && !command.includes('!')) {
        return command;
    }
    const b64 = Buffer.from(command, 'utf-8').toString('base64');
    if (kind === 'bash') {
        return `eval "$(printf %s '${b64}' | base64 -d)"`;
    }
    return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

export function buildFullCommand(terminal: vscode.Terminal, command: string, cwd?: string): string {
    return buildFullCommandFor(detectShellKind(terminal), command, cwd);
}

function buildFullCommandFor(kind: ShellKind, command: string, cwd?: string): string {

    const safeCommand = encodeMultiline(kind, command);
    const wantsCd = !!cwd && cwd !== '.' && cwd !== './';
    if (kind === 'bash') {
        const body = wantsCd ? `cd ${toPosixQuoted(cwd!)} && ${safeCommand}` : safeCommand;

        return `${body}\necho "${EXIT_MARKER}:$?"`;
    }

    const lines = ['& {', '$ok = $true'];
    if (wantsCd) {

        lines.push(`Set-Location ${toPowerShellQuoted(cwd!)}`, '$ok = $?');
    }

    lines.push('if ($ok) {');
    lines.push(safeCommand);
    lines.push('}');

    const rc = '$(if (-not $ok) { 1 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })';
    lines.push(`Write-Output "${EXIT_MARKER}:${rc}"`);
    lines.push('}');
    return lines.join('\n');
}

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

const terminalQueues = new WeakMap<vscode.Terminal, Promise<unknown>>();

const OSC_SEQUENCE_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;

const BARE_OSC_FRAGMENT_REGEX = /(^|\n)\]?633;[A-Z](?:;[^\n]*)?(?=\n|$)/g;

function stripControlSequences(text: string): string {
	return text
		.replace(OSC_SEQUENCE_REGEX, '')
		.replace(CSI_SEQUENCE_REGEX, '')
		.replace(BARE_OSC_FRAGMENT_REGEX, '$1');
}

const forcedShellKinds = new WeakMap<vscode.Terminal, ShellKind>();

function queueOnTerminal<T>(terminal: vscode.Terminal, task: () => Promise<T>): Promise<T> {
    const prev = terminalQueues.get(terminal) || Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    terminalQueues.set(terminal, run);
    return run;
}

async function executeAndWait(terminal: vscode.Terminal, fullCommand: string, timeout: number): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        let timedOut = false;

        let hitDeadline: () => void = () => {};
        const deadline = new Promise<null>(res => { hitDeadline = () => res(null); });
        const timer = setTimeout(() => {
            timedOut = true;
            hitDeadline();
        }, timeout);

        void (async () => {
            let outputStream: AsyncIterable<unknown> | undefined;
            try {

                const execution = terminal.shellIntegration!.executeCommand(`  ${fullCommand}`);
                let output = '';
                outputStream = (execution as any).read();
                const reader = (outputStream as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]();

                const earlyMarkerRegex = new RegExp(`${EXIT_MARKER}:(\\d+)`);
                for (;;) {
                    const chunk = await Promise.race([reader.next(), deadline]);
                    if (chunk === null || chunk.done) {
                        break;
                    }
                    output += chunk.value;
                    if (earlyMarkerRegex.test(output)) {
                        break;
                    }
                }

                clearTimeout(timer);

                let exitCode = 0;
                let markerFound = false;

                const sanitized = stripControlSequences(output);
                const lines = sanitized.split('\n');
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
                        markerFound = true;
                        lines.splice(i, 1);
                        break;
                    }
                }

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

                    cleaned += `\n\n[Timed out after ${timeout}ms — showing the output captured so far. The process may still be running in the terminal; retry with a larger timeout if you need the rest.]`;

                    if (!markerFound && /command not found|syntax error|unexpected token|is not recognized|ParserError/i.test(sanitized)) {
                        cleaned += `\n\n[No exit marker came back and the output above looks like shell parse errors — this terminal is probably running a different shell than expected.]`;
                    }
                    resolve({ output: cleaned, exitCode: 124 });
                    return;
                }

                resolve({ output: cleaned, exitCode });
            } catch (error) {
                clearTimeout(timer);
                if (!timedOut) {
                    reject(new Error(`Failed to read command output: ${error instanceof Error ? error.message : String(error)}`));
                } else {

                    resolve({ output: '', exitCode: 124 });
                }
            } finally {

                try {
                    await (outputStream as any)?.return?.();
                } catch {
                }
            }
        })();
    });
}

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

    terminal.show();

    return queueOnTerminal(terminal, async () => {
        await verifyShellKind(terminal);
        const usedKind = detectShellKind(terminal);
        const fullCommand = buildFullCommand(terminal, command, cwd);
        let result = await executeAndWait(terminal, fullCommand, timeout);

        if (looksLikeWrongWrap(result.output)) {
            logger.info(`[execute_shell_command] Terminal rejected ${usedKind} syntax — retrying once with the other family`);
            forcedShellKinds.set(terminal, usedKind === 'bash' ? 'powershell' : 'bash');
            const retried = await executeAndWait(terminal, buildFullCommandFor(forcedShellKinds.get(terminal)!, command, cwd), timeout);
            if (!looksLikeWrongWrap(retried.output)) {
                result = retried;
            }
        }

        return result;
    });
}

function looksLikeWrongWrap(output: string): boolean {
    if (output.includes(EXIT_MARKER)) {
        return false;
    }
    return /(?:^|\n)\s*\$ok = \$true|(?:^|\n)\s*& \{|bash: (?:syntax error|command not found)|unexpected token|is not recognized|ParserError/i.test(output);
}

export function registerShellTools(server: McpServer, terminal?: vscode.Terminal): void {

    server.tool(
        'execute_shell_command_code',
        `Run a shell command in VS Code terminal.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Optional working directory for the command'),
            timeout: z.number().optional().default(10000).describe('Command timeout in milliseconds (default: 10000)'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ command, cwd, timeout = 10000, workspace }): Promise<CallToolResult> => {
            try {
                const verdict = checkShellCommand(command);
                if (!verdict.allowed) {
                    appendAudit({
                        kind: 'shell_blocked',
                        client: currentScopes().client,
                        detail: `rule=${verdict.rule} cmd=${command.slice(0, 120)}`
                    });
                    notifyDashboard({ ts: Date.now(), kind: 'shell_blocked', client: currentScopes().client, detail: `rule=${verdict.rule} cmd=${command.slice(0, 60)}` });
                    return {
                        content: [{
                            type: 'text',
                            text: `Blocked by shell policy: "${verdict.rule}". This command pattern is not allowed on this machine.`
                        }],
                        isError: true
                    } as unknown as CallToolResult;
                }
                if (!terminal) {
                    throw new Error('Terminal not available');
                }

                let fullCwd = cwd;
                if (workspace !== undefined && workspace.trim() !== '') {
                    fullCwd = path.resolve(resolveWorkspaceFolder(workspace).uri.fsPath, cwd ?? '.');
                } else if (cwd && cwd !== '.' && cwd !== './' && listWorkspaceFolders().length > 1) {

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
