

export interface DiffStats {
    added: number;
    removed: number;
    chunks: number;
    truncated: boolean;
    identical: boolean;
}

export interface DiffResult extends DiffStats {
    text: string;
}

const MAX_DP_CELLS = 2_000_000;
const DEFAULT_CONTEXT = 2;
const DEFAULT_MAX_CHUNKS = 24;
const DEFAULT_MAX_LINES = 160;

type Op = { t: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
    if (text === '') { return []; }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function computeOps(a: string[], b: string[]): Op[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const ops: Op[] = [];
    for (let i = 0; i < start; i++) { ops.push({ t: ' ', line: a[i] }); }

    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);

    if (midA.length === 0 && midB.length === 0) {

    } else if (midA.length === 0) {
        for (const line of midB) { ops.push({ t: '+', line }); }
    } else if (midB.length === 0) {
        for (const line of midA) { ops.push({ t: '-', line }); }
    } else if (midA.length * midB.length > MAX_DP_CELLS) {
        for (const line of midA) { ops.push({ t: '-', line }); }
        for (const line of midB) { ops.push({ t: '+', line }); }
    } else {
        const n = midA.length, m = midB.length;

        const width = m + 1;
        const table = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--) {
            const rowOff = i * width;
            const nextOff = (i + 1) * width;
            for (let j = m - 1; j >= 0; j--) {
                table[rowOff + j] = midA[i] === midB[j]
                    ? table[nextOff + j + 1] + 1
                    : Math.max(table[nextOff + j], table[rowOff + j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) {
                ops.push({ t: ' ', line: midA[i] });
                i++; j++;
            } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
                ops.push({ t: '-', line: midA[i] });
                i++;
            } else {
                ops.push({ t: '+', line: midB[j] });
                j++;
            }
        }
        while (i < n) { ops.push({ t: '-', line: midA[i] }); i++; }
        while (j < m) { ops.push({ t: '+', line: midB[j] }); j++; }
    }

    for (let k = endA; k < a.length; k++) { ops.push({ t: ' ', line: a[k] }); }
    return ops;
}


export function unifiedDiff(oldText: string, newText: string, options?: { contextLines?: number; maxChunks?: number; maxLines?: number }): DiffResult {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const context = Math.max(0, Math.min(options?.contextLines ?? DEFAULT_CONTEXT, 10));
    const maxChunks = Math.max(1, options?.maxChunks ?? DEFAULT_MAX_CHUNKS);
    const maxLines = Math.max(10, options?.maxLines ?? DEFAULT_MAX_LINES);

    const ops = computeOps(a, b);
    let added = 0, removed = 0;
    for (const op of ops) {
        if (op.t === '+') { added++; } else if (op.t === '-') { removed++; }
    }
    if (added === 0 && removed === 0) {
        return { text: '', added: 0, removed: 0, chunks: 0, truncated: false, identical: true };
    }


    interface Raw { start: number; end: number; }
    const groups: Raw[] = [];
    let current: Raw | undefined;
    let pendingGap = -1;
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].t !== ' ') {
            if (!current) {
                current = { start: Math.max(0, i - context), end: i };
                groups.push(current);
            } else if (i - pendingGap <= 2 * context) {
                current.end = i;
            } else {
                current = { start: Math.max(0, i - context), end: i };
                groups.push(current);
            }
            pendingGap = i;
        } else if (current && i - pendingGap > context) {
            current.end = i - 1;
            current = undefined;
        } else if (current) {
            current.end = i;
        }
    }
    if (current) {
        current.end = ops.length - 1;
    }

    const out: string[] = [];
    let chunks = 0;
    let truncated = false;
    let aLine = 1;
    let bLine = 1;
    let consumed = 0;

    const push = (line: string): boolean => {
        if (out.length >= maxLines) {
            truncated = true;
            return false;
        }
        out.push(line.length > 300 ? `${line.slice(0, 300)} …[+${line.length - 300}]` : line);
        return true;
    };

    for (const g of groups) {
        if (chunks >= maxChunks) {
            truncated = true;
            break;
        }

        for (let i = consumed; i < g.start; i++) {
            const op = ops[i];
            if (op.t !== '+') { aLine++; }
            if (op.t !== '-') { bLine++; }
        }
        consumed = g.start;
        let aCount = 0, bCount = 0;
        for (let i = g.start; i <= g.end; i++) {
            const op = ops[i];
            if (op.t !== '+') { aCount++; }
            if (op.t !== '-') { bCount++; }
        }
        chunks += 1;
        if (!push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`)) { break; }
        for (let i = g.start; i <= g.end; i++) {
            const op = ops[i];
            if (op.t !== '+') { aLine++; }
            if (op.t !== '-') { bLine++; }
            if (!push(op.t === ' ' ? ` ${op.line}` : `${op.t}${op.line}`)) { break; }
        }
        if (truncated) { break; }
        consumed = g.end + 1;
    }

    if (truncated && out.length < maxLines) {
        out.push(`…[diff truncated — ${chunks}/${groups.length} hunk(s) shown]`);
    } else if (groups.length - chunks > 0) {
        out.push(`…[${groups.length - chunks} more hunk(s) hidden]`);
    }

    return { text: out.join('\n'), added, removed, chunks, truncated, identical: false };
}


export function diffSummaryLine(d: DiffResult): string {
    if (d.identical) { return 'no changes'; }
    const parts = [`+${d.added} -${d.removed} lines`];
    if (d.chunks > 0) { parts.push(`${d.chunks} hunk${d.chunks > 1 ? 's' : ''}`); }
    if (d.truncated) { parts.push('truncated'); }
    return parts.join(', ');
}
