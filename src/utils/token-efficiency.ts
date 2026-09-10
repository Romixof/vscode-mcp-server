import * as crypto from 'crypto';
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_LINE_CHARS = 400;
const MAX_TOTAL_LINES = 500;
const HEAD_LINES = 350;
const TAIL_LINES = 150;
const WORTHWHILE_RATIO = 0.85;

export interface RecallEntry {
    handle: string;
    kind: string;
    text: string;
    meta?: string;
    createdAt: number;
}

const recallStore = new Map<string, RecallEntry>();
const MAX_RECALL_ENTRIES = 40;

export function rememberOriginal(kind: string, text: string, meta?: string): string {
    const handle = crypto.createHash('sha1').update(`${kind}\u0000${meta ?? ''}\u0000${text.length}\u0000${Date.now()}`).digest('hex').slice(0, 10);
    recallStore.set(handle, { handle, kind, text, meta, createdAt: Date.now() });
    while (recallStore.size > MAX_RECALL_ENTRIES) {
        const oldest = [...recallStore.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) {
            break;
        }
        recallStore.delete(oldest.handle);
    }
    return handle;
}

export function getOriginal(handle: string): RecallEntry | undefined {
    return recallStore.get(handle);
}

export interface CompactionResult {
    text: string;
    originalChars: number;
    compactChars: number;
    strategy: string;
}

function stripProgressRedraws(text: string): string {
    return text.split('\n').map(line => {
        if (!line.includes('\r')) {
            return line;
        }
        const frames = line.split('\r');
        return frames[frames.length - 1];
    }).join('\n');
}

function collapseDuplicateLines(lines: string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
        const last = out[out.length - 1];
        if (line !== '' && last !== undefined) {
            const base = last.replace(/ ×(\d+) repeat$/, '');
            if (base === line) {
                const m = last.match(/ ×(\d+) repeat$/);
                const count = m ? parseInt(m[1], 10) + 1 : 2;
                out[out.length - 1] = `${line} ×${count} repeat`;
                continue;
            }
        }
        out.push(line);
    }
    return out;
}

function truncateLongLines(lines: string[]): string[] {
    return lines.map(line => line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)} …[+${line.length - MAX_LINE_CHARS} chars]`
        : line);
}

function headTailCap(lines: string[]): { lines: string[]; dropped: number } {
    if (lines.length <= MAX_TOTAL_LINES) {
        return { lines, dropped: 0 };
    }
    const dropped = lines.length - HEAD_LINES - TAIL_LINES;
    return {
        lines: [...lines.slice(0, HEAD_LINES), `…[${dropped} lines dropped — use retrieve_output_code for the full original]`, ...lines.slice(lines.length - TAIL_LINES)],
        dropped
    };
}

function finish(lines: string[], original: string, strategy: string): CompactionResult {
    const text = lines.join('\n');
    return { text, originalChars: original.length, compactChars: text.length, strategy };
}

const GIT_NOISE = /^\s*(remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Total \d+|Delta compression|Resolving deltas)/;

function compactGitTransport(lines: string[]): string[] {
    return lines.filter(l => !GIT_NOISE.test(l));
}

function compactGitStatus(lines: string[]): string[] {
    return lines.filter(l => !/^\s*\(use "git /.test(l));
}

function compactGitDiff(lines: string[]): string[] {
    return lines.filter(l => !/^index [0-9a-f]+\.\.[0-9a-f]+ \d{3,4}/.test(l) && !/^(old|new) mode /.test(l));
}

function compactPkgInstall(lines: string[]): { lines: string[]; strategy: string } {
    const kept: string[] = [];
    let deprecatedSeen = 0;
    let deprecatedSample = '';
    for (const line of lines) {
        if (/npm warn deprecated /i.test(line)) {
            deprecatedSeen++;
            if (deprecatedSeen <= 2) {
                kept.push(line);
            }
            if (deprecatedSeen === 3) {
                deprecatedSample = line.slice(0, 80);
            }
            continue;
        }
        kept.push(line);
    }
    if (deprecatedSeen > 2) {
        kept.push(`[+${deprecatedSeen - 2} more "npm WARN deprecated" lines collapsed${deprecatedSample ? ` — e.g. "${deprecatedSample}"` : ''}]`);
    }
    return { lines: kept, strategy: 'pkg-install' };
}

const TEST_KEEP = /(FAIL|Failed|failed|failing|✗|✘|●|Error\b|ERROR\b|AssertionError|Expected|Received|expected|received|Tests?:|Suites?:|Test Files|passed|Pass:|OK \()/;

function compactTestRunner(lines: string[]): { lines: string[]; strategy: string } {
    const kept = lines.filter(l => TEST_KEEP.test(l));
    const tail = lines.slice(-3);
    const merged = [...kept];
    for (const line of tail) {
        if (!merged.includes(line)) {
            merged.push(line);
        }
    }
    if (merged.length < lines.length) {
        merged.push(`[${lines.length - merged.length} non-summary lines dropped — failures and totals kept]`);
    }
    return { lines: merged, strategy: 'test-runner' };
}

function compactBuild(lines: string[], raw: string): { lines: string[]; strategy: string } {
    const hasErrors = /error|ERROR|Error:|failed|FAILED/.test(raw);
    if (!hasErrors) {
        const kept = lines.slice(-6);
        kept.unshift('[build succeeded — all but the last lines trimmed]');
        return { lines: kept, strategy: 'build' };
    }
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (/error|ERROR|Error:|FAILED|failed/.test(lines[i])) {
            kept.push(...lines.slice(i, i + 3));
            i += 2;
        }
    }
    if (kept.length < lines.length) {
        kept.push(`[${lines.length - kept.length} non-error lines dropped]`);
    }
    return { lines: kept, strategy: 'build-errors' };
}

function categorize(command: string): string {
    const cmd = command.toLowerCase();
    if (/\bgit\s+(push|pull|fetch|clone|remote)\b/.test(cmd)) {
        return 'git-transport';
    }
    if (/\bgit\s+status\b/.test(cmd)) {
        return 'git-status';
    }
    if (/\bgit\s+diff\b/.test(cmd)) {
        return 'git-diff';
    }
    if (/\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|ci|audit)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b/.test(cmd)) {
        return 'pkg-install';
    }
    if (/\b(jest|vitest|mocha|pytest|playwright|rspec|cargo test|go test|bun test|deno test|npm test|npm run test|npx (jest|vitest|playwright))\b/.test(cmd)) {
        return 'test-runner';
    }
    if (/\b(tsc\b|next build|webpack|vite build|cargo build|cargo clippy|gradle|mvn\b|make\b)/.test(cmd)) {
        return 'build';
    }
    return 'generic';
}

export function compactCommandOutput(command: string, output: string): CompactionResult {
    const category = categorize(command);
    const withoutProgress = stripProgressRedraws(output);
    let normalized = withoutProgress.replace(/\r/g, '\n');
    let lines = normalized.split('\n').map(l => l.replace(/\s+$/, '')).filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
    let strategy = category;
    if (category === 'git-transport') {
        lines = compactGitTransport(lines);
    }
    else if (category === 'git-status') {
        lines = compactGitStatus(lines);
    }
    else if (category === 'git-diff') {
        lines = compactGitDiff(lines);
    }
    else if (category === 'pkg-install') {
        const r = compactPkgInstall(lines);
        lines = r.lines;
        strategy = r.strategy;
    }
    else if (category === 'test-runner') {
        const r = compactTestRunner(lines);
        lines = r.lines;
        strategy = r.strategy;
    }
    else if (category === 'build') {
        const r = compactBuild(lines, output);
        lines = r.lines;
        strategy = r.strategy;
    }
    lines = truncateLongLines(lines);
    lines = collapseDuplicateLines(lines);
    const capped = headTailCap(lines);
    lines = capped.lines;
    const result = finish(lines, output, strategy + (capped.dropped > 0 ? '+cap' : ''));
    if (result.compactChars >= result.originalChars * WORTHWHILE_RATIO) {
        return { text: output, originalChars: output.length, compactChars: output.length, strategy: 'skipped' };
    }
    return result;
}

export function compactOcrText(text: string): CompactionResult {
    const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
    const collapsed = collapseDuplicateLines(lines);
    const noBlanks = collapsed.filter(l => l !== '');
    const result = finish(noBlanks, text, 'ocr');
    if (result.compactChars >= result.originalChars * WORTHWHILE_RATIO) {
        return { text, originalChars: text.length, compactChars: text.length, strategy: 'skipped' };
    }
    return result;
}

export function formatCompactionNotice(result: CompactionResult, handle: string): string {
    const saved = result.originalChars > 0 ? Math.max(1, Math.round((1 - result.compactChars / result.originalChars) * 100)) : 0;
    return `[@vscode-mcp: output compacted ${result.originalChars}→${result.compactChars} chars (~${saved}% saved, filter: ${result.strategy}). Full original available: retrieve_output_code "${handle}"]`;
}

export function registerTokenEfficiencyTools(server: McpServer): void {
    server.tool('retrieve_output_code', `Retrieves a previously stored FULL original output (shell command output, OCR text, …) by its handle, whenever a "[@vscode-mcp: ... retrieve_output_code "handle"]" notice in a compacted tool result is not enough to answer.

Handles are short hex strings shown inside compaction notices. The store lives in memory in this VS Code window: handles survive as long as the window does, are capped to the most recent entries, and do NOT survive a VS Code reload. Results are paged: pass offset/maxChars to walk through very large originals.`, {
        handle: z.string().describe('Handle from a compaction notice, e.g. "a1b2c3d4e5"'),
        offset: z.number().optional().default(0).describe('Character offset into the original to start from. Defaults to 0.'),
        maxChars: z.number().optional().default(20000).describe('Maximum characters to return in this page. Defaults to 20000.')
    }, async ({ handle, offset = 0, maxChars = 20000 }) => {
        const entry = getOriginal(handle);
        if (!entry) {
            return {
                content: [{
                        type: 'text' as const,
                        text: `Unknown or expired handle "${handle}". Handles are in-memory only (per VS Code window, most recent ${MAX_RECALL_ENTRIES} stored outputs) — if the original is gone, re-run the command or re-run the OCR call.`
                    }],
                isError: true
            };
        }
        const start = Math.max(0, Math.min(offset, entry.text.length));
        const end = Math.min(entry.text.length, start + Math.max(200, maxChars));
        const chunk = entry.text.slice(start, end);
        const remaining = entry.text.length - end;
        const header = `Original ${entry.kind} output (handle "${handle}"${entry.meta ? `, ${entry.meta}` : ''}) — chars ${start}–${end} of ${entry.text.length}:\n\n`;
        const footer = remaining > 0
            ? `\n\n[… ${remaining} more chars — retrieve_output_code "${handle}" with offset=${end} for the next page]`
            : '\n\n[end of original]';
        return {
            content: [{
                    type: 'text' as const,
                    text: header + chunk + footer
                }]
        };
    });
}
