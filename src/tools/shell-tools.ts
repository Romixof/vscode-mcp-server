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
import { compactCommandOutput, rememberOriginal, formatCompactionNotice } from '../utils/token-efficiency';
import { planModeIntercept } from './safety-tools';
import { pythonCacheGuard } from '../utils/runtime-facts';

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

    const explicit = explicitShellKind(terminal);
    if (explicit) {
        return explicit;
    }

    const forced = forcedShellKinds.get(terminal);
    if (forced) {
        return forced;
    }

    for (const hint of shellHints()) {
        const fromHint = matchShellKind(hint);
        if (fromHint) {
            return fromHint;
        }
    }
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

export function isShellKindVerified(terminal: vscode.Terminal): boolean {
        return verifiedShellKinds.has(terminal) || explicitShellKind(terminal) !== undefined;
}

export function describeShellKind(terminal: vscode.Terminal): string {
        const kind = detectShellKind(terminal);
        return isShellKindVerified(terminal)
                ? kind
                : `${kind} (assumed from the Windows default profile; not yet confirmed against the running terminal — call get_server_info_code again after any shell command, or just write bash and the server will adapt)`;
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

export const SHELL_TIMEOUT_MS = 25000;

export const CLIENT_CEILING_MS = 30000;

export const RESPONSE_RESERVE_MS = 3000;

export const CLIENT_BUDGET_MS = CLIENT_CEILING_MS - RESPONSE_RESERVE_MS;

export function resolveShellTerminal(
        terminal?: vscode.Terminal,
        provider?: () => vscode.Terminal | undefined
): vscode.Terminal | undefined {
        if (provider) {
                const fresh = provider();
                if (fresh) {
                        return fresh;
                }
        }
        return terminal;
}

export async function waitForShellIntegration(terminal: vscode.Terminal, timeout = 5000): Promise<boolean> {
    if (terminal.shellIntegration) {
        return true;
    }

    if (terminal.exitStatus !== undefined) {
        return false;
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

interface TerminalQueue {
        tail: Promise<unknown>;
        depth: number;
}

const terminalQueues = new WeakMap<vscode.Terminal, TerminalQueue>();

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

export function terminalBusyError(waitedMs: number, requestedMs: number): Error {
        return new Error(
                `Shell terminal is busy — this call already waited ${waitedMs}ms in the queue and asked for ${requestedMs}ms, ` +
                `which cannot finish inside the ${CLIENT_BUDGET_MS}ms budget before the client disconnects at ${CLIENT_CEILING_MS}ms. ` +
                `Run it with background_task_code, or retry once the terminal is free.`
        );
}

export function queueOnTerminal<T>(terminal: vscode.Terminal, task: () => Promise<T>, requestedTimeoutMs?: number): Promise<T> {
        const entry = terminalQueues.get(terminal);
        const previous = entry?.tail ?? Promise.resolve();
        const depth = (entry?.depth ?? 0) + 1;
        const enqueuedAt = Date.now();

        const run = previous.catch(() => undefined).then(async () => {
                if (requestedTimeoutMs !== undefined) {
                        const waited = Date.now() - enqueuedAt;
                        if (waited + requestedTimeoutMs > CLIENT_BUDGET_MS) {
                                throw terminalBusyError(waited, requestedTimeoutMs);
                        }
                }
                return task();
        });

        const tail = run.then(() => undefined, () => undefined);
        terminalQueues.set(terminal, { tail, depth });

        void tail.then(() => {
                const current = terminalQueues.get(terminal);
                if (!current || current.tail !== tail) {
                        return;
                }
                const nextDepth = current.depth - 1;
                if (nextDepth <= 0) {
                        terminalQueues.delete(terminal);
                } else {
                        terminalQueues.set(terminal, { tail: current.tail, depth: nextDepth });
                }
        });

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
    timeout: number = SHELL_TIMEOUT_MS
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
            const opposite = usedKind === 'bash' ? 'powershell' : 'bash';
            logger.info(`[execute_shell_command] Terminal rejected ${usedKind} syntax — retrying once as ${opposite}`);
            forcedShellKinds.set(terminal, opposite);
            const retried = await executeAndWait(terminal, buildFullCommandFor(opposite, command, cwd), timeout);
            if (!looksLikeWrongWrap(retried.output)) {
                result = retried;
                if (!explicitShellKind(terminal)) {
                    verifiedShellKinds.set(terminal, opposite);
                }
                return result;
            }
            forcedShellKinds.delete(terminal);
        }

        return result;
    }, timeout);
}

function looksLikeWrongWrap(output: string): boolean {
    if (output.includes(EXIT_MARKER)) {
        return false;
    }
    return /(?:^|\n)\s*\$ok = \$true|(?:^|\n)\s*& \{|bash: syntax error|unexpected token|is not recognized as the name of a cmdlet|ParserError/i.test(output);
}

export function registerShellTools(server: McpServer, terminal?: vscode.Terminal, terminalProvider?: () => vscode.Terminal | undefined): void {

    server.tool(
        'execute_shell_command_code',
        `Executes shell commands in the VS Code integrated terminal.

WHEN TO USE: builds, tests, installs, git operations, anything that actually mutates. For reads (file contents, listings, text search, git status/diff/log, diagnostics) prefer the dedicated read-only tools — they auto-approve without a prompt, so keeping this tool for real mutations makes approval the exception.

Timeout: default ${SHELL_TIMEOUT_MS}ms. The calling client disconnects at ${CLIENT_CEILING_MS}ms whatever you pass, so a larger timeout returns nothing at all. A request over the ${CLIENT_BUDGET_MS}ms budget is clamped and the clamp is reported back. A command that runs past the budget returns what was captured with exit code 124. Anything that legitimately takes minutes (builds, test suites, installs) belongs in background_task_code, which detaches and never blocks. The terminal runs one command at a time: a call that would still be queued when the budget runs out is rejected, not waited on.

Shell: ${terminal ? detectShellKind(terminal) : 'unknown'}. Write syntax for that shell. Sending the other family's syntax fails before your command runs.

Token efficiency: output is compacted by default (progress bars stripped, repeated lines collapsed, long lines truncated, head+tail capped, with category filters for git, installs, test runners and builds). A notice carries a retrieve_output_code handle for the full original. Pass outputMode "raw" to skip compaction.

cwd defaults to the workspace root.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Optional working directory for the command'),
            timeout: z.number().optional().default(SHELL_TIMEOUT_MS).describe(`Command timeout in milliseconds (default: ${SHELL_TIMEOUT_MS})`),
            outputMode: z.enum(['compact', 'raw']).optional().default('compact').describe('"compact" filters output and stays retrievable via retrieve_output_code; "raw" is untouched.'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ command, cwd, timeout = SHELL_TIMEOUT_MS, outputMode = 'compact', workspace }): Promise<CallToolResult> => {
            try {
                const pm = planModeIntercept('execute_shell_command_code', `{ command: ${JSON.stringify(command.slice(0, 160))}${cwd && cwd !== '.' ? `, cwd: ${JSON.stringify(cwd)}` : ''} }`);
                if (pm) { return pm; }
                const verdict = checkShellCommand(command);
                if (!verdict.allowed) {
                    appendAudit({
                        kind: 'shell_blocked',
                        client: currentScopes().client,
                        detail: `rule=${verdict.rule} cmd=${command.slice(0, 120)}`
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: `Blocked by shell policy: "${verdict.rule}". This command pattern is not allowed on this machine.`
                        }],
                        isError: true
                    } as unknown as CallToolResult;
                }
                const activeTerminal = resolveShellTerminal(terminal, terminalProvider);
                if (!activeTerminal) {
                    throw new Error('Terminal not available');
                }

                let fullCwd = cwd;
                if (workspace !== undefined && workspace.trim() !== '') {
                    fullCwd = path.resolve(resolveWorkspaceFolder(workspace).uri.fsPath, cwd ?? '.');
                } else if (cwd === '.' || cwd === './' || cwd === undefined) {
                    const folders = listWorkspaceFolders();
                    if (folders.length === 1) {
                        fullCwd = folders[0].uri.fsPath;
                    }
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

                const guardedCommand = pythonCacheGuard(command) ?? command;

                const requestedTimeout = timeout;
                const effectiveTimeout = Math.min(requestedTimeout, CLIENT_BUDGET_MS);
                const clampNotice = requestedTimeout > effectiveTimeout
                        ? `Timeout clamped from ${requestedTimeout}ms to ${effectiveTimeout}ms: the calling client disconnects at ${CLIENT_CEILING_MS}ms regardless.\n\n`
                        : '';

                const { output, exitCode } = await executeShellCommand(activeTerminal, guardedCommand, fullCwd, effectiveTimeout);

                if (outputMode === 'compact') {
                    const compaction = compactCommandOutput(command, output);
                    if (compaction.strategy !== 'skipped') {
                        const handle = rememberOriginal('shell', output, `Command: ${command}`);
                        const compactResult: CallToolResult = {
                            content: [
                                {
                                    type: 'text',
                                    text: `${clampNotice}Command: ${command}\nExit code: ${exitCode}\n\nOutput (compacted):\n${compaction.text}\n\n${formatCompactionNotice(compaction, handle)}`
                                }
                            ]
                        };
                        return compactResult;
                    }
                }

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `${clampNotice}Command: ${command}\nExit code: ${exitCode}\n\nOutput:\n${output}`
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
