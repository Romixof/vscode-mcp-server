const MAX_DIFF_LINES = 40;
const MAX_LINE_CHARS = 200;

function firstDifference(a: string, b: string): number {
        const max = Math.min(a.length, b.length);
        for (let i = 0; i < max; i++) {
                if (a[i] !== b[i]) {
                        return i;
                }
        }
        return a.length === b.length ? -1 : max;
}

function lineNumberAt(text: string, offset: number): number {
        let line = 1;
        for (let i = 0; i < offset && i < text.length; i++) {
                if (text[i] === '\n') {
                        line++;
                }
        }
        return line;
}

export function diffPreviewForEdit(path: string, before: string, after: string): string {
        if (before === after) {
                return `No change in ${path}.`;
        }
        const at = firstDifference(before, after);
        if (at === -1) {
                return `No change in ${path}.`;
        }
        const beforeLine = lineNumberAt(before, at);
        const afterLine = lineNumberAt(after, at);
        const bLines = before.split('\n');
        const aLines = after.split('\n');

        const from = Math.max(0, beforeLine - 2);
        const to = Math.min(bLines.length, beforeLine + 2);
        const aFrom = Math.max(0, afterLine - 2);
        const aTo = Math.min(aLines.length, afterLine + 2);

        const rows: string[] = [];
        for (let i = 0; i < Math.min(to - from, aTo - aFrom, MAX_DIFF_LINES); i++) {
                const oldText = (bLines[from + i] ?? '').slice(0, MAX_LINE_CHARS);
                const newText = (aLines[aFrom + i] ?? '').slice(0, MAX_LINE_CHARS);
                if (oldText === newText) {
                        rows.push(`  ${from + i + 1}   ${oldText}`);
                } else {
                        rows.push(`- ${from + i + 1}   ${oldText}`);
                        rows.push(`+ ${aFrom + i + 1}   ${newText}`);
                }
        }
        if (rows.length === 0) {
                return `Changed ${path} around line ${beforeLine}.`;
        }
        return `Changed ${path} around line ${beforeLine}:\n\n${rows.join('\n')}`;
}
