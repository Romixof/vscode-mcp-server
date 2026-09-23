import { execFile } from 'child_process';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { getWorkspaceIndex, buildGraphBundle, isTestFile } from '../utils/codegraph';



function gitExec(args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise(resolve => {
        execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() });
        });
    });
}

function capList(items: string[], max: number): string {
    if (items.length <= max) { return items.join('\n'); }
    return `${items.slice(0, max).join('\n')}\n…[${items.length - max} more]`;
}

export function registerCodeGraphTools(server: McpServer): void {

    server.tool(
        'call_graph_code',
        `Call graph of a symbol, served by the .codegraph/ index (built on first use, then incremental — delete the folder to force a rebuild).

WHEN TO USE: search_symbols_code FINDS a function, this one EXPLAINS it — what it calls, or what calls it, up to a configurable depth. Great before refactors ("who else calls this?") and for tracing logic.

Heuristic, name-based analysis of TS/JS/Python sources: same-named symbols merge, dynamic dispatch is not resolved. Location lines are best-effort.`,
        {
            symbol: z.string().describe('Symbol name (function, method, class)'),
            depth: z.number().int().min(1).max(6).optional().default(3).describe('Traversal depth (default 3)'),
            direction: z.enum(['callees', 'callers', 'both']).optional().default('callees').describe('Which direction to expand'),
            maxNodes: z.number().int().min(5).max(100).optional().default(40).describe('Maximum nodes printed'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ symbol, depth = 3, direction = 'callees', maxNodes = 40, workspace }): Promise<CallToolResult> => {
            try {
                const root = resolveWorkspaceFolder(workspace).uri.fsPath;
                const { index, stats } = getWorkspaceIndex(root);
                const bundle = buildGraphBundle(index);

                const locs = bundle.decls.get(symbol);
                if (!locs || locs.length === 0) {
                    const similar = [...bundle.decls.keys()].filter(n => n.toLowerCase().includes(symbol.toLowerCase())).slice(0, 8);
                    return { content: [{ type: 'text', text: `Symbol "${symbol}" not found in the index (${stats.files} files${stats.rescanned ? `, ${stats.rescanned} rescanned` : ''}).${similar.length ? ` Similar names: ${similar.join(', ')}.` : ''}` }] };
                }

                const out: string[] = [];
                out.push(`${symbol} — ${locs.length} declaration(s): ${locs.map(l => `${l.file}:${l.line} (${l.kind})`).join(', ')}`);
                out.push(`Index: ${stats.files} files${stats.cached ? ' (cached)' : `, ${stats.rescanned} rescanned`}. Heuristic name-based graph.`);

                const printed = { count: 1 };
                const expand = (name: string, edges: Map<string, Map<string, number>>, prefix: string, d: number, seen: Set<string>): void => {
                    if (d > depth || printed.count >= maxNodes) { return; }
                    const inner = edges.get(name);
                    if (!inner || inner.size === 0) {
                        if (d === 1) { out.push(`${prefix}(nothing${edges === bundle.callers ? ' calls it' : ' — leaf'})`); }
                        return;
                    }
                    const targets = [...inner.entries()].sort((a, b) => b[1] - a[1]);
                    for (let i = 0; i < targets.length && printed.count < maxNodes; i++) {
                        const [target, count] = targets[i];
                        const last = i === targets.length - 1 || printed.count >= maxNodes - 1;
                        const defs = bundle.decls.get(target);
                        const where = defs && defs.length > 0 ? ` ${defs[0].file}:${defs[0].line}` : ' (external/unknown)';
                        const branch = last ? '└─' : '├─';
                        const mark = seen.has(target) ? ' ↺' : '';
                        out.push(`${prefix}${branch} ${target}${where}${count > 1 ? ` ×${count}` : ''}${mark}`);
                        printed.count += 1;
                        if (!seen.has(target)) {
                            seen.add(target);
                            expand(target, edges, `${prefix}${last ? '   ' : '│  '}`, d + 1, seen);
                            seen.delete(target);
                        }
                    }
                };

                if (direction === 'callees' || direction === 'both') {
                    out.push('', 'CALLED BY THIS SYMBOL:');
                    expand(symbol, bundle.callees, '  ', 1, new Set([symbol]));
                }
                if (direction === 'callers' || direction === 'both') {
                    out.push('', 'CALLS THIS SYMBOL:');
                    expand(symbol, bundle.callers, '  ', 1, new Set([symbol]));
                }
                if (printed.count >= maxNodes) {
                    out.push(`…[node cap ${maxNodes} reached — narrow the query or raise maxNodes]`);
                }
                return { content: [{ type: 'text', text: out.join('\n') }] };
            } catch (error) {
                console.error('[call_graph_code] Error:', error);
                throw error;
            }
        }
    );

    server.tool(
        'test_impact_code',
        `Maps changed source files to the test files that (transitively) import them, via the .codegraph/ import graph.

WHEN TO USE: before committing or after edits — know exactly which tests to run instead of firing the whole suite.

Files default to the current git working-tree changes (git status, staged included). Test files are *.test.* / *.spec.* / anything under a tests folder.`,
        {
            files: z.array(z.string()).optional().describe('Source files (workspace-relative). Defaults to git working-tree changes.'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ files, workspace }): Promise<CallToolResult> => {
            try {
                const root = resolveWorkspaceFolder(workspace).uri.fsPath;
                const { index, stats } = getWorkspaceIndex(root);

                let targets = files ?? [];
                if (!files || files.length === 0) {
                    const st = await gitExec(['status', '--porcelain'], root);
                    if (st.code !== 0) {
                        throw new Error(`git status failed: ${st.out}`);
                    }
                    targets = st.out.split('\n').map(l => l.trim().replace(/^\w+\s+/, '').replace(/^"|"$/g, ''))
                        .filter(l => l.length > 0);
                }
                if (targets.length === 0) {
                    return { content: [{ type: 'text', text: 'No changed files (clean working tree) and no files given.' }] };
                }

                const norm = (p: string): string => p.replace(/\\/g, '/');
                const indexed = new Set(Object.keys(index.files));
                const out: string[] = [];
                let covered = 0, untested = 0, notFound = 0;

                for (const raw of targets) {
                    const rel = norm(raw);
                    if (isTestFile(rel)) {
                        out.push(`${rel} -> IS a test file (run it directly)`);
                        covered += 1;
                        continue;
                    }
                    if (!indexed.has(rel)) {
                        out.push(`${rel} -> not in index (non-code, ignored, or new)`);
                        notFound += 1;
                        continue;
                    }

                    const tests = new Set<string>();
                    const seen = new Set<string>([rel]);
                    const queue = [rel];
                    const importers = bundleFor(index).importers;
                    while (queue.length > 0) {
                        const cur = queue.shift()!;
                        for (const dep of importers.get(cur) ?? []) {
                            if (seen.has(dep)) { continue; }
                            seen.add(dep);
                            if (isTestFile(dep)) {
                                tests.add(dep);
                            } else {
                                queue.push(dep);
                            }
                        }
                    }
                    if (tests.size === 0) {
                        out.push(`${rel} -> NO test imports it directly or transitively`);
                        untested += 1;
                    } else {
                        covered += 1;
                        out.push(`${rel} -> ${[...tests].sort().join(', ')}`);
                    }
                }

                const summary = `${covered} file(s) with test coverage, ${untested} without, ${notFound} outside the index (${stats.files} files indexed${stats.rescanned ? `, ${stats.rescanned} rescanned` : ''}).`;
                return { content: [{ type: 'text', text: `${summary}\n\n${capList(out, 60)}` }] };
            } catch (error) {
                console.error('[test_impact_code] Error:', error);
                throw error;
            }
        }
    );

    server.tool(
        'migration_diff_code',
        `Compares two git revisions (base...head) and reports: changed files with +/- counts, EXPORTED symbols added and removed, and likely breaking changes.

WHEN TO USE: before merging or after pulling — "what does this branch change in the public API?" Parse-based on the unified diff of code files (TS/JS/Python declarations), so macro-level and fast.

Removed exports and renamed suspects are flagged BREAKING. Depth is one level: signature internals are not analyzed.`,
        {
            base: z.string().describe('Base revision: branch name, tag or SHA (e.g. "main")'),
            head: z.string().optional().default('HEAD').describe('Head revision (default: HEAD)'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ base, head = 'HEAD', workspace }): Promise<CallToolResult> => {
            try {
                const root = resolveWorkspaceFolder(workspace).uri.fsPath;
                const verify = await gitExec(['rev-parse', '--verify', base], root);
                if (verify.code !== 0) {
                    throw new Error(`Unknown revision "${base}". List branches with git branch or use a tag/SHA.`);
                }
                const nameStatus = await gitExec(['diff', '--name-status', `${base}...${head}`], root);
                if (nameStatus.code !== 0) {
                    throw new Error(`git diff failed: ${nameStatus.out}`);
                }
                const fileLines = nameStatus.out.split('\n').filter(Boolean);
                if (fileLines.length === 0) {
                    return { content: [{ type: 'text', text: `No differences between ${base} and ${head}.` }] };
                }

                const stats = await gitExec(['diff', '--shortstat', `${base}...${head}`], root);
                const diff = await gitExec(['diff', '--unified=0', '--no-color', `${base}...${head}`, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py'], root);

                const added: string[] = [], removed: string[] = [];
                const DECL = /(?:^|[+\-\s])(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:class|interface|type|enum)\s+(\w+)|const\s+(\w+)\s*[=:]|(?:def|class)\s+(\w+))/;
                let currentFile = '';
                for (const line of diff.out.split('\n')) {
                    const fm = line.match(/^diff --git a\/(.+?) b\//);
                    if (fm) { currentFile = fm[1]; continue; }
                    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) { continue; }
                    const isAdd = line.startsWith('+');
                    const m = DECL.exec(line);
                    if (!m) { continue; }
                    const name = m[1] || m[2] || m[3] || m[4];
                    if (!name) { continue; }
                    (isAdd ? added : removed).push(`${name} (${currentFile})`);
                }

                const removedNames = new Set(removed.map(r => r.split(' ')[0]));
                const addedNames = new Set(added.map(r => r.split(' ')[0]));
                const renamed = new Set([...removedNames].filter(n => addedNames.has(n)));

                const breaking = removed.filter(r => !renamed.has(r.split(' ')[0]));
                const out: string[] = [];
                out.push(`Migration ${base} -> ${head}: ${fileLines.length} file(s) changed. ${stats.out}`);
                out.push('', `FILES:`);
                out.push(capList(fileLines.map(l => l.replace(/\t/g, '  ')), 50));
                out.push('', added.length > 0 ? `DECLARATIONS ADDED (${added.length}):` : 'DECLARATIONS ADDED: none');
                if (added.length > 0) { out.push(capList(added, 40)); }
                out.push('', breaking.length > 0 ? `BREAKING — DECLARATIONS REMOVED (${breaking.length}):` : 'DECLARATIONS REMOVED: none');
                if (breaking.length > 0) { out.push(capList(breaking, 40)); }
                if (renamed.size > 0) {
                    const renamedList = [...renamed];
                    out.push('', `RENAMED/CHANGED IN PLACE (${renamedList.length}): ${renamedList.slice(0, 20).join(', ')}`);
                }
                out.push('', 'Heuristic declaration scan of the unified diff — review the flagged files before merging.');
                return { content: [{ type: 'text', text: out.join('\n') }] };
            } catch (error) {
                console.error('[migration_diff_code] Error:', error);
                throw error;
            }
        }
    );
}


let bundleCache: { index: ReturnType<typeof getWorkspaceIndex>['index']; bundle: ReturnType<typeof buildGraphBundle> } | undefined;
function bundleFor(index: ReturnType<typeof getWorkspaceIndex>['index']): ReturnType<typeof buildGraphBundle> {
    if (!bundleCache || bundleCache.index !== index) {
        bundleCache = { index, bundle: buildGraphBundle(index) };
    }
    return bundleCache.bundle;
}
