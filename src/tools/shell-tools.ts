import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, resolveInputPath, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { logger } from '../utils/logger';

export type ShellKind = 'bash' | 'powershell';

// Marker appended to every command so we can recover its real exit code and
// strip the terminal echo/prompt noise from the captured output
const EXIT_MARKER = '__MCP_EXIT';

// Signals that name a shell family explicitly, checked in order
function matchShellKind(text: string): ShellKind | undefined {
    if (/powershell|pwsh|\bcmd\b/i.test(text)) {
        return 'powershell';
    }
    // Word boundaries: "MCP Shell Commands" must not read as sh
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

/**
 * VS Code's own idea of the default shell, most reliable signal first, each
 * entry judged on its own so a foreign platform's synced setting can never
 * outvote the local one. A Windows box whose default profile is Git Bash must
 * not be read as PowerShell.
 */
function shellHints(): string[] {
    const hints: string[] = [];
    const envShell = (vscode.env as { shell?: string }).shell;
    if (envShell) {
        hints.push(envShell);
    }
    try {
        const config = vscode.workspace.getConfiguration('terminal');
        // The setting exists per platform under its own name; the platform id
        // itself is not part of the key (win32 -> ...windows)
        const profileKey =
            process.platform === 'win32' ? 'integrated.defaultProfile.windows' :
            process.platform === 'darwin' ? 'integrated.defaultProfile.osx' :
            'integrated.defaultProfile.linux';
        const profile = config.get<string>(profileKey);
        if (profile) {
            hints.push(profile);
        }
    } catch {
        // settings unreadable; fall through on what we have
    }
    return hints;
}

/**
 * Detects which family of shell the terminal is running so the cd prefix and
 * exit-code capture use valid syntax (PowerShell 5.1 rejects `&&` chains)
 * @param terminal The terminal to inspect
 */
export function detectShellKind(terminal: vscode.Terminal): ShellKind {
    // A settled probe verdict wins: it reflects what actually answered
    const verified = verifiedShellKinds.get(terminal);
    if (verified) {
        return verified;
    }
    // A force-flip from a demonstrated wrong wrap outranks the static guess
    // (but not a later positive verdict, which replaces it)
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

// Probe result per terminal; POSIX shells answer it, PowerShell cannot parse it,
// so whatever comes back settles the family question once and for all
const verifiedShellKinds = new WeakMap<vscode.Terminal, ShellKind>();

function probeCommand(): string {
    return 'printf \'__MCP_SHELL:%s\\n\' "${BASH_VERSION:-none}"';
}

/**
 * Positive evidence for the other family: only this literal answer settles
 * 'powershell'. A finished round-trip proves nothing — the probe itself can
 * arrive mangled (a busy pty ate the leading characters of the very first
 * submission once, turning printf into rintf) and must never poison the
 * verdict by absence.
 */
function powerShellProbeCommand(): string {
    return 'Write-Output "__MCP_PS:$($PSVersionTable.PSVersion.Major)"';
}

/**
 * Settled shell kind for callers that build dialect-specific fragments
 * themselves instead of passing a plain command. Verification goes through the
 * same per-terminal queue as executions, so the probe can never interleave
 * with a command that is already running.
 * @param terminal The terminal to inspect
 */
export async function resolveShellKind(terminal: vscode.Terminal): Promise<ShellKind> {
    if (!terminal.shellIntegration) {
        const available = await waitForShellIntegration(terminal);
        if (!available || !terminal.shellIntegration) {
            // Nothing to probe against: the static guess is all we have
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
    // Explicit signals (shell path, telling terminal name) are trusted as-is.
    // Everything else gets one probe round-trip, whatever the guess was: the
    // guess can be wrong in both directions (a stale reused terminal running
    // Git Bash while the default profile says PowerShell), and probing costs
    // genuine PowerShell sessions nothing worse than one visible
    // CommandNotFound line — cached afterwards, never repeated.
    if (!explicitShellKind(terminal)) {
        try {
            let { output } = await executeAndWait(terminal, probeCommand(), 2000);
            if (!/__MCP_SHELL:(none|\d)/.test(output)) {
                // No POSIX answer: ask the other family directly instead of
                // settling anything by absence
                const ps = await executeAndWait(terminal, powerShellProbeCommand(), 2000);
                output = ps.output;
            }
            if (/__MCP_SHELL:(none|\d)/.test(output)) {
                kind = 'bash';
                verifiedShellKinds.set(terminal, kind);
            } else if (/__MCP_PS:\d/.test(output)) {
                // Positive PowerShell answer: the only way absence of a bash
                // reply may settle anything. A finished-but-silent round-trip
                // (mangled probe on a busy pty) stays uncached and retries.
                kind = 'powershell';
                verifiedShellKinds.set(terminal, kind);
            }
            // No readable verdict either way: keep the static guess for this
            // call and probe again on the next one
        } catch {
            // unreadable stream: same as no answer, retried on a later call
        }
    }
    return kind;
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
    return buildFullCommandFor(detectShellKind(terminal), command, cwd);
}

function buildFullCommandFor(kind: ShellKind, command: string, cwd?: string): string {
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

// Shell integration leaks its own control sequences into the read stream:
// OSC 633 marks command boundaries (a bare "]633;C" is what showed up in
// results), and other OSC/CSI escapes can ride along with prompt redraws.
// Stripping them keeps tool output byte-clean for the client.
// Shell-integration control sequences and friends, stripped from captures
const OSC_SEQUENCE_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Some paths deliver the sequence with its ESC byte already swallowed, leaving
// a bare "]633;X" fragment on a line of its own; only whole-line fragments go,
// so legitimate text containing "633;C" mid-line survives
const BARE_OSC_FRAGMENT_REGEX = /(^|\n)\]?633;[A-Z](?:;[^\n]*)?(?=\n|$)/g;

function stripControlSequences(text: string): string {
	return text
		.replace(OSC_SEQUENCE_REGEX, '')
		.replace(CSI_SEQUENCE_REGEX, '')
		.replace(BARE_OSC_FRAGMENT_REGEX, '$1');
}

// A reused terminal whose origin nobody remembers can carry a wrong static
// guess forever: hints say PowerShell, the pty actually runs Git Bash. When
// the family in charge demonstrably rejects our template AND neither probe
// answers, this override force-flips the dialect for the next attempt —
// the strongest evidence there is.
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
                let markerFound = false;
                // Control sequences go first: a stray "]633;C" glued to a line
                // could otherwise break marker matching or echo filtering
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
                    // Parse errors in the capture mean the syntax never ran: a
                    // wrong shell guess sprays them within milliseconds instead
                    // of ever reaching the marker. A quiet long-running process
                    // times out too, so bare absence of the marker proves nothing.
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

    terminal.show();

    // Verification runs inside the queue so the probe can never interleave
    // with a real command; buildFullCommand then reads the settled kind
    return queueOnTerminal(terminal, async () => {
        await verifyShellKind(terminal);
        const usedKind = detectShellKind(terminal);
        const fullCommand = buildFullCommand(terminal, command, cwd);
        let result = await executeAndWait(terminal, fullCommand, timeout);

        // A finished command that never reached its marker while spraying
        // foreign-family parse errors means the dialect was wrong. The wrap is
        // retried ONCE in the opposite family inside the same call — the user
        // gets their answer instead of a timeout — and the override persists
        // so later calls start in the right dialect.
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

/**
 * True when the captured stream shows the template itself was rejected by a
 * shell of the other family: no exit marker plus parse errors naming bash
 * constructs or PowerShell constructs. Both markers absent AND errors present
 * keeps a legitimately failing command (which still prints its marker) out of
 * this branch.
 */
function looksLikeWrongWrap(output: string): boolean {
    if (output.includes(EXIT_MARKER)) {
        return false;
    }
    return /(?:^|\n)\s*\$ok = \$true|(?:^|\n)\s*& \{|bash: (?:syntax error|command not found)|unexpected token|is not recognized|ParserError/i.test(output);
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
