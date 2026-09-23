import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { checkShellCommand } from '../auth/shellguard';
import { appendAudit } from '../auth/audit';
import { currentScopes } from '../auth/toolgate';
import { compactCommandOutput, rememberOriginal, formatCompactionNotice } from '../utils/token-efficiency';



interface BackgroundTask {
    id: string;
    command: string;
    cwd: string;
    proc: ChildProcess;
    startedAt: number;
    finishedAt?: number;
    exitCode?: number;
    output: string;
    killed: boolean;
}

const tasks = new Map<string, BackgroundTask>();
const MAX_CONCURRENT = 8;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_FINISHED_AGE_MS = 60 * 60 * 1000;

function reap(): void {
    const now = Date.now();
    for (const [id, t] of tasks) {
        if (t.finishedAt && now - t.finishedAt > MAX_FINISHED_AGE_MS) {
            tasks.delete(id);
        }
    }
}

function taskLine(t: BackgroundTask): string {
    const state = t.finishedAt === undefined
        ? 'running'
        : `exit ${t.exitCode}${t.killed ? ' (killed)' : ''}`;
    const secs = ((t.finishedAt ?? Date.now()) - t.startedAt) / 1000;
    const bytes = Buffer.byteLength(t.output, 'utf-8');
    return `${t.id}  ${state}  ${secs.toFixed(1)}s  ${bytes}B  cwd=${t.cwd}  ${t.command.slice(0, 80)}`;
}

export function registerBackgroundTools(server: McpServer): void {
    server.tool(
        'background_task_code',
        `Runs a long shell command (builds, test suites, installs, dev servers) DETACHED and returns immediately with a task id; the MCP call is never blocked and nothing is truncated by the 10s terminal timeout.

WHEN TO USE: any command that outlives a normal execute_shell_command_code timeout. For quick commands keep execute_shell_command_code.

Actions:
- start {command, cwd}: launches via the system shell, returns task id at once. Shell policy (shellguard) still applies.
- list: all tasks with state, duration, output size.
- output {task_id, offset, maxChars}: polls a task — running tasks return the tail so far plus byte offset; finished tasks return exit code and paged output.
- kill {task_id}: terminates a running task.

Finished tasks are kept for 1 hour. Output is capped at 200 KB (tail kept).`,
        {
            action: z.enum(['start', 'list', 'output', 'kill']).describe('Task action'),
            command: z.string().optional().describe('start: the command to run'),
            cwd: z.string().optional().default('.').describe('start: working directory (default: workspace root)'),
            task_id: z.string().optional().describe('output/kill: id returned by start'),
            offset: z.number().int().min(0).optional().default(0).describe('output: character offset to read from (paginate big logs)'),
            maxChars: z.number().int().min(200).optional().default(20000).describe('output: maximum characters returned per call'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ action, command, cwd = '.', task_id, offset = 0, maxChars = 20000, workspace }): Promise<CallToolResult> => {
            try {
                reap();
                if (action === 'start') {
                    if (!command || !command.trim()) {
                        throw new Error('start requires a command');
                    }
                    const running = [...tasks.values()].filter(t => t.finishedAt === undefined).length;
                    if (running >= MAX_CONCURRENT) {
                        return { content: [{ type: 'text', text: `Refused: ${running} background tasks already running (cap ${MAX_CONCURRENT}). Kill or wait: background_task_code(action="list").` }] } as CallToolResult;
                    }
                    const verdict = checkShellCommand(command);
                    if (!verdict.allowed) {
                        appendAudit({
                            kind: 'shell_blocked',
                            client: currentScopes().client,
                            detail: `rule=${verdict.rule} cmd=${command.slice(0, 120)} (background)`
                        });
                        return { content: [{ type: 'text', text: `Blocked by shell policy: "${verdict.rule}".` }] } as CallToolResult;
                    }
                    const root = resolveWorkspaceFolder(workspace).uri.fsPath;
                    const fullCwd = path.isAbsolute(cwd) && cwd !== '.' ? cwd : path.resolve(root, cwd === '.' ? '' : cwd);
                    const id = crypto.randomBytes(3).toString('hex');
                    const proc = spawn(command, [], {
                        shell: true,
                        cwd: fullCwd,
                        env: { ...process.env },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    const task: BackgroundTask = { id, command, cwd: fullCwd, proc, startedAt: Date.now(), output: '', killed: false };
                    tasks.set(id, task);
                    const onChunk = (chunk: Buffer | string): void => {
                        task.output += chunk.toString('utf-8');
                        if (task.output.length > MAX_OUTPUT_CHARS) {
                            task.output = task.output.slice(task.output.length - MAX_OUTPUT_CHARS);
                        }
                    };
                    proc.stdout?.on('data', onChunk);
                    proc.stderr?.on('data', onChunk);
                    proc.on('close', code => {
                        task.finishedAt = Date.now();
                        task.exitCode = code ?? -1;
                    });
                    proc.on('error', err => {
                        task.output += `\n[spawn error] ${err.message}`;
                        task.finishedAt = Date.now();
                        task.exitCode = -1;
                    });
                    return { content: [{ type: 'text', text: `Started task ${id} (cwd=${fullCwd}).\n${task.command}\n\nPoll with background_task_code(action="output", task_id="${id}"). The call returns immediately; the process keeps running.` }] };
                }

                if (action === 'list') {
                    if (tasks.size === 0) {
                        return { content: [{ type: 'text', text: 'No background tasks in this window.' }] };
                    }
                    const lines = [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt).map(taskLine);
                    return { content: [{ type: 'text', text: `Background tasks:\n\n${lines.join('\n')}` }] };
                }

                if (action === 'output') {
                    const t = task_id ? tasks.get(task_id) : undefined;
                    if (!t) {
                        throw new Error(`Unknown task "${task_id ?? ''}". List ids with background_task_code(action="list").`);
                    }
                    if (t.finishedAt === undefined && offset === 0) {
                        const tail = t.output.length > 4000 ? t.output.slice(-4000) : t.output;
                        const compaction = compactCommandOutput(t.command, tail);
                        const body = compaction.strategy !== 'skipped' ? compaction.text : tail;
                        const note = t.output.length > tail.length ? `\n\n[…${t.output.length - tail.length} earlier chars — poll with offset to page through]` : '';
                        return { content: [{ type: 'text', text: `Task ${t.id} STILL RUNNING (${((Date.now() - t.startedAt) / 1000).toFixed(0)}s):\n${body}${note}` }] };
                    }
                    if (t.finishedAt === undefined) {
                        const chunk = t.output.slice(offset, offset + Math.max(200, maxChars));
                        const consumed = offset + chunk.length;
                        const remaining = Math.max(0, t.output.length - consumed);
                        return { content: [{ type: 'text', text: `Task ${t.id} STILL RUNNING — chars ${offset}–${consumed} of ${t.output.length}:\n${chunk}${remaining > 0 ? `\n\n[…${remaining} more — call again with offset=${consumed}]` : ''}` }] };
                    }

                    if (offset === 0) {
                        const compaction = compactCommandOutput(t.command, t.output);
                        if (compaction.strategy !== 'skipped' && compaction.text.length < t.output.length) {
                            const handle = rememberOriginal('background', t.output, `Task ${t.id}: ${t.command}`);
                            return { content: [{ type: 'text', text: `Task ${t.id} FINISHED — exit code ${t.exitCode}${t.killed ? ' (killed)' : ''} in ${((t.finishedAt - t.startedAt) / 1000).toFixed(1)}s.\n\nOutput (compacted):\n${compaction.text}\n\n${formatCompactionNotice(compaction, handle)}` }] };
                        }
                    }
                    const chunk = t.output.slice(offset, offset + Math.max(200, maxChars));
                    const consumed = offset + chunk.length;
                    const remaining = Math.max(0, t.output.length - consumed);
                    return { content: [{ type: 'text', text: `Task ${t.id} FINISHED — exit code ${t.exitCode}${t.killed ? ' (killed)' : ''} in ${((t.finishedAt - t.startedAt) / 1000).toFixed(1)}s.\nChars ${offset}–${consumed} of ${t.output.length}:\n${chunk}${remaining > 0 ? `\n\n[…${remaining} more — call again with offset=${consumed}]` : '\n\n[end of output]'}` }] };
                }


                const t = task_id ? tasks.get(task_id) : undefined;
                if (!t) {
                    throw new Error(`Unknown task "${task_id ?? ''}".`);
                }
                if (t.finishedAt !== undefined) {
                    return { content: [{ type: 'text', text: `Task ${t.id} already finished (exit ${t.exitCode}).` }] };
                }
                t.killed = true;
                const ok = t.proc.kill();
                if (!ok && t.proc.pid) {
                    try { process.kill(t.proc.pid, 'SIGKILL'); } catch {  }
                }
                return { content: [{ type: 'text', text: `Kill signal sent to task ${t.id}. Check final state with background_task_code(action="output", task_id="${t.id}").` }] };
            } catch (error) {
                console.error('[background_task_code] Error:', error);
                throw error;
            }
        }
    );
}
