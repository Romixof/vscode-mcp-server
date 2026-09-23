import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveRelativeToolPath, resolveWorkspaceFolder, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { unifiedDiff, diffSummaryLine } from '../utils/diff';






let planModeEnabled = false;

export function isPlanMode(): boolean {
    return planModeEnabled;
}

export function planModeIntercept(toolName: string, detail: string): CallToolResult | undefined {
    if (!planModeEnabled) {
        return undefined;
    }
    return {
        content: [{
            type: 'text',
            text: `PLAN MODE is ON — nothing was executed.\nWould run: ${toolName} ${detail}\nReview this plan, then turn plan mode off with plan_mode_code(enabled=false) and repeat the call to execute it.`
        }]
    };
}





const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
    const probe = buf.subarray(0, 8192);
    return probe.includes(0);
}

function readTextFile(fsPath: string, displayPath: string): string {
    const stat = fs.statSync(fsPath);
    if (stat.size > MAX_PREVIEW_BYTES) {
        throw new Error(`File too large to preview (${stat.size} bytes, cap ${MAX_PREVIEW_BYTES}): ${displayPath}`);
    }
    const buf = fs.readFileSync(fsPath);
    if (looksBinary(buf)) {
        throw new Error(`Binary file — text diff preview not available: ${displayPath}`);
    }
    return buf.toString('utf-8');
}

function gitExec(args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise(resolve => {
        execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() });
        });
    });
}





export function registerSafetyTools(server: McpServer): void {

    server.tool(
        'diff_preview_code',
        `Dry-run preview of a file edit: returns the unified diff that replace_lines_code / create_file_code / move_file_code / rename_file_code WOULD produce, without touching anything.

WHEN TO USE: before replacing or rewriting non-trivial content, before overwriting an existing file, whenever you are not 100% sure of the outcome. Read-only and free to call.

Ops mirror the real tools: "replace_lines" (path, startLine, endLine, content, optional originalCode), "create" (path, content, overwrite), "move" (sourcePath, targetPath, overwrite), "rename" (filePath, newName, overwrite).`,
        {
            op: z.enum(['replace_lines', 'create', 'move', 'rename']).describe('Which edit to preview'),
            path: z.string().optional().describe('Target file (replace_lines/rename: file to modify)'),
            startLine: z.number().optional().describe('replace_lines: 1-based start line'),
            endLine: z.number().optional().describe('replace_lines: 1-based end line (inclusive)'),
            content: z.string().optional().describe('replace_lines/create: the new content'),
            originalCode: z.string().optional().describe('replace_lines: if given, must match the current lines exactly (same rule as replace_lines_code)'),
            sourcePath: z.string().optional().describe('move: file to move'),
            targetPath: z.string().optional().describe('move: destination path'),
            newName: z.string().optional().describe('rename: new file name in the same directory'),
            overwrite: z.boolean().optional().default(false).describe('create/move/rename: allow replacing an existing target'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ op, path: p, startLine, endLine, content, originalCode, sourcePath, targetPath, newName, overwrite = false, workspace }): Promise<CallToolResult> => {
            try {
                if (op === 'replace_lines') {
                    if (!p || startLine === undefined || endLine === undefined || content === undefined) {
                        throw new Error('replace_lines requires path, startLine, endLine and content');
                    }
                    const target = resolveRelativeToolPath(p, workspace);
                    const current = readTextFile(target.fsPath, p);
                    const lines = current.split('\n');
                    const s = startLine - 1, e = endLine - 1;
                    if (s < 0 || s >= lines.length || e < s || e >= lines.length) {
                        throw new Error(`Line range ${startLine}-${endLine} out of range (file has ${lines.length} lines)`);
                    }
                    const original = lines.slice(s, e + 1).join('\n');
                    if (originalCode !== undefined && originalCode !== original) {
                        throw new Error(`originalCode does not match current lines ${startLine}-${endLine}. Read the exact lines again with read_file_code.`);
                    }
                    const next = [...lines.slice(0, s), ...content.split('\n'), ...lines.slice(e + 1)].join('\n');
                    const d = unifiedDiff(current, next);
                    const text = `--- a/${p}\n+++ b/${p}\n${d.text}`;
                    return { content: [{ type: 'text', text: `Preview (replace_lines ${startLine}-${endLine} in ${p}): ${diffSummaryLine(d)}\n\n${text}\n\nNothing was written. Apply with replace_lines_code(path="${p}", startLine=${startLine}, endLine=${endLine}, ...).` }] };
                }
                if (op === 'create') {
                    if (!p || content === undefined) {
                        throw new Error('create requires path and content');
                    }
                    const target = resolveRelativeToolPath(p, workspace);
                    const exists = fs.existsSync(target.fsPath);
                    if (exists && !overwrite) {
                        throw new Error(`${p} already exists and overwrite=false. Pass overwrite=true to preview the replacement.`);
                    }
                    if (!exists) {
                        const newLines = content.split('\n').length;
                        const shown = content.split('\n').slice(0, 40);
                        const rest = newLines > 40 ? `\n…[${newLines - 40} more lines]` : '';
                        return { content: [{ type: 'text', text: `Preview (create ${p}): NEW FILE, ${newLines} lines.\n\n--- /dev/null\n+++ b/${p}\n${shown.map(l => `+${l}`).join('\n')}${rest}\n\nNothing was written. Apply with create_file_code(path="${p}", content, overwrite=true).` }] };
                    }
                    const current = readTextFile(target.fsPath, p);
                    const d = unifiedDiff(current, content);
                    const text = d.identical ? '(identical content)' : `--- a/${p}\n+++ b/${p}\n${d.text}`;
                    return { content: [{ type: 'text', text: `Preview (create ${p}, overwrite): ${diffSummaryLine(d)}\n\n${text}\n\nNothing was written. Apply with create_file_code(path="${p}", content, overwrite=true).` }] };
                }
                if (op === 'move' || op === 'rename') {
                    const src = op === 'move' ? sourcePath : p;
                    const dirOf = op === 'move' ? path.dirname(sourcePath ?? '') : path.dirname(p ?? '');
                    let dst = op === 'move' ? targetPath : (newName ? path.join(dirOf, newName) : undefined);
                    if (!src || !dst) {
                        throw new Error(op === 'move' ? 'move requires sourcePath and targetPath' : 'rename requires path and newName');
                    }
                    const from = resolveRelativeToolPath(src, workspace);
                    const to = resolveRelativeToolPath(dst, workspace);
                    if (!fs.existsSync(from.fsPath)) {
                        throw new Error(`Source not found: ${src}`);
                    }
                    const stat = fs.statSync(from.fsPath);
                    if (fs.existsSync(to.fsPath) && !overwrite) {
                        throw new Error(`Target already exists: ${dst} (pass overwrite=true to preview the replacement)`);
                    }
                    const isMove = op === 'move';
                    const same = from.fsPath.toLowerCase() === to.fsPath.toLowerCase();
                    return {
                        content: [{
                            type: 'text',
                            text: `Preview (${op}): ${src} -> ${dst}${same ? ' (case-only rename)' : ''}, ${stat.isDirectory() ? 'directory' : `${stat.size} bytes, content unchanged`}${fs.existsSync(to.fsPath) ? ', OVERWRITES existing target' : ''}.\n\nNothing was moved. Apply with ${isMove ? `move_file_code(sourcePath="${src}", targetPath="${dst}", overwrite=${overwrite})` : `rename_file_code(filePath="${src}", newName="${newName}", overwrite=${overwrite})`}.`
                        }]
                    };
                }
                throw new Error(`Unknown op: ${op}`);
            } catch (error) {
                console.error('[diff_preview_code] Error:', error);
                throw error;
            }
        }
    );





    server.tool(
        'checkpoint_code',
        `One-call undo point for the working tree: "annuler tout".

WHEN TO USE: save BEFORE a large refactor, a batch of automated edits, or any risky command; restore to roll the workspace back.

Actions:
- save: snapshots UNCOMMITTED TRACKED changes as a named checkpoint (git stash created NON-destructively, working tree keeps its changes; clean trees record HEAD). Untracked files are listed but not captured.
- list: shows checkpoints and whether their stash still exists.
- restore: reapplies the checkpoint stash to the working tree (stash is kept; requires confirm=true because it overwrites current uncommitted changes on conflict).
- drop: removes a checkpoint.

Checkpoints are recorded in .vscode-mcp/checkpoints.json; outside a git repo only metadata is stored (no restore).`,
        {
            action: z.enum(['save', 'list', 'restore', 'drop']).describe('Checkpoint action'),
            name: z.string().optional().describe('Checkpoint name (save/restore/drop). Defaults to cp-<timestamp> on save.'),
            confirm: z.boolean().optional().default(false).describe('restore only: must be true to overwrite current uncommitted changes'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ action, name, confirm = false, workspace }): Promise<CallToolResult> => {
            try {
                const root = resolveWorkspaceFolder(workspace).uri.fsPath;
                const cpDir = path.join(root, '.vscode-mcp');
                const cpFile = path.join(cpDir, 'checkpoints.json');

                const loadRecords = (): Array<{ name: string; type: 'stash' | 'clean'; sha?: string; msg?: string; ts: number }> => {
                    try {
                        const parsed = JSON.parse(fs.readFileSync(cpFile, 'utf-8'));
                        return Array.isArray(parsed) ? parsed : [];
                    } catch {
                        return [];
                    }
                };
                const saveRecords = (recs: Array<{ name: string; type: 'stash' | 'clean'; sha?: string; msg?: string; ts: number }>): void => {
                    fs.mkdirSync(cpDir, { recursive: true });
                    fs.writeFileSync(cpFile, JSON.stringify(recs.slice(-30), null, 1));
                };

                const git = (args: string[]) => gitExec(args, root);
                const inRepo = await git(['rev-parse', '--is-inside-work-tree']);
                const isRepo = inRepo.code === 0 && inRepo.out.trim() === 'true';

                if (action === 'save') {
                    if (!isRepo) {
                        throw new Error('Not a git repository — checkpoint save needs git for a restorable snapshot.');
                    }
                    const label = (name && name.trim()) || `cp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
                    if (/[\\\r\n]/.test(label)) {
                        throw new Error('Checkpoint name must not contain backslashes or newlines');
                    }
                    const records = loadRecords();
                    if (records.some(r => r.name === label)) {
                        throw new Error(`Checkpoint "${label}" already exists — pick another name or drop it first.`);
                    }
                    const status = await git(['status', '--porcelain']);
                    if (!status.out.trim()) {
                        const head = await git(['rev-parse', 'HEAD']);
                        records.push({ name: label, type: 'clean', sha: head.out.split('\n')[0], ts: Date.now() });
                        saveRecords(records);
                        return { content: [{ type: 'text', text: `Checkpoint "${label}" saved: working tree is CLEAN, marked at HEAD ${head.out.slice(0, 10)}. Restoring it later will discard changes made since.` }] };
                    }
                    const stashMsg = `mcp-checkpoint: ${label}`;
                    const shaOut = await git(['stash', 'create']);
                    const sha = shaOut.out.trim();
                    if (!sha) {
                        throw new Error('git stash create returned nothing (unusual state). Use stash_changes_code instead.');
                    }
                    const store = await git(['stash', 'store', '-m', stashMsg, sha]);
                    if (store.code !== 0) {
                        throw new Error(`git stash store failed: ${store.out}`);
                    }
                    records.push({ name: label, type: 'stash', sha, msg: stashMsg, ts: Date.now() });
                    saveRecords(records);
                    const files = status.out.split('\n').filter(Boolean).length;
                    const untracked = await git(['ls-files', '--others', '--exclude-standard']);
                    const untrackedList = untracked.out ? untracked.out.split('\n').filter(Boolean) : [];
                    const untrackedNote = untrackedList.length > 0
                        ? `\nNOTE: ${untrackedList.length} untracked file(s) are NOT captured by the stash (tracked changes only). Copy them aside first if they matter.`
                        : '';
                    return { content: [{ type: 'text', text: `Checkpoint "${label}" saved (${files} dirty tracked paths). Working tree UNCHANGED — keep editing. Undo later with checkpoint_code(action="restore", name="${label}", confirm=true).${untrackedNote}` }] };
                }

                if (action === 'list') {
                    const records = loadRecords();
                    if (records.length === 0) {
                        return { content: [{ type: 'text', text: 'No checkpoints saved yet.' }] };
                    }
                    let stashShas: string[] = [];
                    if (isRepo) {
                        const list = await git(['stash', 'list', '--pretty=format:%H']);
                        stashShas = list.out ? list.out.split('\n').map(s => s.trim()) : [];
                    }
                    const lines = records.map(r => {
                        const alive = r.type === 'clean' ? `HEAD ${r.sha?.slice(0, 10)}` : (stashShas.includes(r.sha ?? '') ? 'stash present' : 'stash GONE');
                        const when = new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ');
                        return `${r.name}  ${when}  ${r.type}  ${alive}`;
                    });
                    return { content: [{ type: 'text', text: `Checkpoints (oldest first):\n\n${lines.join('\n')}\n\nRestore with checkpoint_code(action="restore", name=..., confirm=true).` }] };
                }

                if (action === 'restore') {
                    if (!confirm) {
                        return { content: [{ type: 'text', text: 'Refused: restoring overwrites current uncommitted changes. Re-run with confirm=true (list first with action="list").' }] } as CallToolResult;
                    }
                    if (!isRepo) {
                        throw new Error('Not a git repository — restore unavailable.');
                    }
                    const records = loadRecords();
                    const target = (name && records.filter(r => r.name === name).pop()) || records[records.length - 1];
                    if (!target) {
                        throw new Error('No checkpoints saved.');
                    }
                    if (target.type === 'clean') {
                        const head = await git(['rev-parse', 'HEAD']);
                        if (head.out.split('\n')[0] !== target.sha) {
                            return { content: [{ type: 'text', text: `Refused: HEAD moved since checkpoint "${target.name}" was taken (${target.sha?.slice(0, 10)}). Use stash_changes_code or git checkout explicitly.` }] } as CallToolResult;
                        }
                        const res = await git(['checkout', '--', '.']);
                        return { content: [{ type: 'text', text: `Restored clean checkpoint "${target.name}": tracked files reverted to HEAD (untracked files untouched).\n${res.out}` }] };
                    }
                    const list = await git(['stash', 'list', '--pretty=format:%H']);
                    const shas = list.out ? list.out.split('\n').map(s => s.trim()) : [];
                    const idx = shas.indexOf(target.sha ?? '');
                    if (idx === -1) {
                        throw new Error(`Stash for checkpoint "${target.name}" no longer exists (dropped manually?).`);
                    }
                    const res = await git(['stash', 'apply', `stash@{${idx}}`]);
                    return { content: [{ type: 'text', text: `Restored checkpoint "${target.name}" (stash kept for repeated restores).\n${res.out}${/conflict|error/i.test(res.out) ? '\nConflicts detected — resolve them with list_conflicts_code(). A clean restore is still available: stash_changes_code(action="push") then checkpoint_code(action="restore") again.' : ''}` }] };
                }


                const records = loadRecords();
                const target = (name && records.filter(r => r.name === name).pop()) || records[records.length - 1];
                if (!target) {
                    throw new Error('No checkpoints saved.');
                }
                if (target.type === 'stash' && isRepo) {
                    const list = await git(['stash', 'list', '--pretty=format:%H']);
                    const shas = list.out ? list.out.split('\n').map(s => s.trim()) : [];
                    const idx = shas.indexOf(target.sha ?? '');
                    if (idx !== -1) {
                        await git(['stash', 'drop', `stash@{${idx}}`]);
                    }
                }
                saveRecords(records.filter(r => r !== target));
                return { content: [{ type: 'text', text: `Checkpoint "${target.name}" dropped.` }] };
            } catch (error) {
                console.error('[checkpoint_code] Error:', error);
                throw error;
            }
        }
    );





    server.tool(
        'plan_mode_code',
        `Toggles PLAN MODE: a global switch that turns execution tools (execute_shell_command_code, run_sql_query_code, run_task_code, build_project_code, run_tests_code, restart_dev_server_code, profile_command_code, run_alias_code) into safe stubs that only DESCRIBE what they would run, without executing anything.

WHEN TO USE: enable it while drafting dangerous operations (DB writes, rm-adjacent commands, server restarts), present the plan, then disable it to execute. File reads and read-only tools keep working, so the agent can still explore while planning.`,
        {
            enabled: z.boolean().describe('true = plan mode ON (execution tools describe only), false = OFF (normal execution)'),
            status: z.boolean().optional().default(false).describe('Only report current state, do not change it')
        },
        async ({ enabled, status = false }): Promise<CallToolResult> => {
            const before = planModeEnabled;
            if (!status) {
                planModeEnabled = enabled;
            }
            const state = planModeEnabled ? 'ON — shell/DB/workflow execution tools only describe what they would run' : 'OFF — tools execute normally';
            const changed = before !== planModeEnabled ? ` (was ${before ? 'ON' : 'OFF'})` : '';
            return { content: [{ type: 'text', text: `PLAN MODE ${state}${changed}. ${planModeEnabled ? 'Present your plan, then call plan_mode_code(enabled=false) to execute.' : ''}` }] };
        }
    );
}
