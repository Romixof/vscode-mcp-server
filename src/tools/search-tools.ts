import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const MAX_FILE_BYTES = 1500000;
const MAX_FILES_SCANNED = 20000;
const MAX_LINE_CHARS = 200;

const COMMON_SKIP_DIRS = new Set([
    'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '__pycache__',
    '.venv', 'venv', 'target', '.gradle', 'bin', 'obj'
]);

export function globToRegExp(glob: string): RegExp {
    const parts: string[] = [];
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    parts.push('(?:.*/)?');
                } else {
                    parts.push('.*');
                }
            } else {
                parts.push('[^/]*');
            }
        } else if (ch === '?') {
            parts.push('.');
        } else {
            parts.push(ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        }
    }
    return new RegExp(`^${parts.join('')}$`, 'i');
}

interface ScanState {
    files: number;
    skippedDirs: number;
}

function walk(root: string, rel: string, files: string[], state: ScanState, skipCommon: boolean): void {
    if (state.files >= MAX_FILES_SCANNED) {
        return;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
        state.skippedDirs += 1;
        return;
    }
    for (const entry of entries) {
        if (state.files >= MAX_FILES_SCANNED) {
            return;
        }
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || (skipCommon && COMMON_SKIP_DIRS.has(entry.name))) {
                continue;
            }
            walk(root, childRel, files, state, skipCommon);
        } else if (entry.isFile()) {
            state.files += 1;
            files.push(childRel);
        }
    }
}

export function registerSearchTools(server: McpServer, resolveRoot: (inputPath: string, workspace?: string) => string): void {
    server.tool(
        'search_workspace_code',
        `Searches the workspace for lines matching a regular expression and returns the matches grouped by file with 1-based line numbers. Strictly read-only: it never writes, moves or opens anything, so MCP clients can auto-approve it.

WHEN TO USE: finding where a symbol/string/config is used, locating a definition by name, auditing occurrences before an edit. This replaces grep/rg through the shell tool — no manual approval is needed for this tool.

Scope: starts at "path" (default: workspace root). Common vendor/build directories (node_modules, dist, out, build, .git, dot-directories, ...) are skipped unless skipCommon=false. Files above 1.5 MB and binary-looking files are ignored. Use "glob" to restrict by file name or relative path (e.g. "*.ts", "src/**/*.py"). Results are capped (default 50, max 200); narrow the pattern, set a glob or a more specific path when the cap is hit.`,
        {
            pattern: z.string().describe('Regular expression to match against each line (e.g. "function\\s+parse", "TODO|FIXME")'),
            path: z.string().optional().default('.').describe('Directory or file to search in, relative to the workspace root (default: ".")'),
            glob: z.string().optional().describe('Restrict to files matching this glob: a pattern without "/" (e.g. "*.ts") matches the file NAME at any depth; a pattern with "/" (e.g. "src/**/*.py") matches the relative path — "**" matches any depth'),
            caseSensitive: z.boolean().optional().default(false).describe('Case-sensitive matching (default: insensitive)'),
            maxResults: z.number().int().optional().default(DEFAULT_MAX_RESULTS).describe(`Max matched lines returned (1-${HARD_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS})`),
            skipCommon: z.boolean().optional().default(true).describe('Skip common vendor/build/dot directories (default: true)'),
            workspace: z.string().optional().describe('Multi-root workspaces only: folder name or 1-based index anchoring the search')
        },
        async ({ pattern, path: searchPath = '.', glob, caseSensitive = false, maxResults = DEFAULT_MAX_RESULTS, skipCommon = true, workspace }): Promise<CallToolResult> => {
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, caseSensitive ? '' : 'i');
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                return { content: [{ type: 'text' as const, text: `Invalid regular expression: ${message}. For a literal search, escape the special characters (e.g. use \\. instead of .).` }], isError: true };
            }
            const root = resolveRoot(searchPath, workspace);
            if (!fs.existsSync(root)) {
                return { content: [{ type: 'text' as const, text: `Search path does not exist: "${searchPath}" -> ${root}` }], isError: true };
            }
            if (!fs.statSync(root).isDirectory()) {
                return { content: [{ type: 'text' as const, text: `Search path is a file — searching it directly for pattern matches is not supported; use path pointing at a directory (rooted search) or read the file with read_file_code.` }], isError: true };
            }
            const started = Date.now();
            const files: string[] = [];
            const state: ScanState = { files: 0, skippedDirs: 0 };
            walk(root, '', files, state, skipCommon);
            const matcher = glob ? globToRegExp(glob) : undefined;
            const baseOnly = glob !== undefined && !glob.includes('/');
            const cap = Math.min(Math.max(Math.trunc(maxResults), 1), HARD_MAX_RESULTS);
            const lines: string[] = [];
            let scanned = 0;
            let matchedFiles = 0;
            let matches = 0;
            let capHit = false;
            for (const rel of files) {
                if (matcher) {
                    const matchTarget = baseOnly ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
                    if (!matcher.test(matchTarget)) {
                        continue;
                    }
                }
                scanned += 1;
                const full = path.join(root, rel);
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(full);
                } catch {
                    continue;
                }
                if (stat.size > MAX_FILE_BYTES) {
                    continue;
                }
                let text: string;
                try {
                    text = fs.readFileSync(full, 'utf8');
                } catch {
                    continue;
                }
                if (text.includes('\u0000')) {
                    continue;
                }
                const fileLines = text.split(/\r?\n/);
                let fileMatches = 0;
                for (let i = 0; i < fileLines.length; i++) {
                    if (!regex.test(fileLines[i])) {
                        continue;
                    }
                    fileMatches += 1;
                    matches += 1;
                    if (fileMatches === 1) {
                        matchedFiles += 1;
                        lines.push(rel);
                    }
                    if (lines.length < cap * 2) {
                        lines.push(`  ${i + 1}: ${fileLines[i].trim().slice(0, MAX_LINE_CHARS)}`);
                    }
                    if (matches >= cap) {
                        capHit = true;
                        break;
                    }
                }
                if (capHit) {
                    break;
                }
            }
            const header = `Search /${pattern}/${caseSensitive ? '' : 'i'} in ${root}${glob ? ` (glob: ${glob})` : ''} — ${matches} match(es) in ${matchedFiles} file(s), ${scanned} file(s) scanned, ${state.skippedDirs} dir(s) skipped, ${Date.now() - started}ms`;
            const body = lines.length > 0 ? `\n${lines.join('\n')}` : '';
            const footer = capHit
                ? `\n[Stopped early: hit the ${cap}-match cap — narrow the pattern, add a glob or a more specific path, or raise maxResults (max ${HARD_MAX_RESULTS}).]`
                : '';
            return { content: [{ type: 'text' as const, text: `${header}${body}${footer}` }] };
        }
    );
}
