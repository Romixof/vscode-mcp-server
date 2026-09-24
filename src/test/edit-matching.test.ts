import * as assert from 'assert';

interface Match {
        line: number;
        column: number;
        context: string;
}

function locate(content: string, needle: string): Match[] {
        const out: Match[] = [];
        if (needle.length === 0) {
                return out;
        }
        let from = 0;
        for (;;) {
                const idx = content.indexOf(needle, from);
                if (idx === -1) { break; }
                const before = content.slice(0, idx);
                const line = before.split('\n').length;
                const column = idx - (before.lastIndexOf('\n') + 1) + 1;
                const lines = content.split('\n');
                const start = Math.max(0, line - 2);
                const end = Math.min(lines.length, line + 1);
                out.push({ line, column, context: lines.slice(start, end).join('\n') });
                from = idx + needle.length;
        }
        return out;
}

function replaceOnce(content: string, needle: string, replacement: string): string {
        const idx = content.indexOf(needle);
        return content.slice(0, idx) + replacement + content.slice(idx + needle.length);
}

function replaceAll(content: string, needle: string, replacement: string): { text: string; count: number } {
        if (needle.length === 0) { return { text: content, count: 0 }; }
        let count = 0;
        let from = 0;
        for (;;) {
                const idx = content.indexOf(needle, from);
                if (idx === -1) { break; }
                count++;
                from = idx + needle.length;
        }
        if (count === 0) { return { text: content, count: 0 }; }
        return { text: content.split(needle).join(replacement), count };
}

suite('edit_file_code matching', () => {
        const sample = [
                'function alpha() {',
                '    return 1;',
                '}',
                '',
                'function beta() {',
                '    return 1;',
                '}',
                ''
        ].join('\n');

        test('finds a unique match with its 1-based line', () => {
                const hits = locate(sample, 'return 2;');
                assert.strictEqual(hits.length, 0);
                const one = locate('const x = 1;\nconst y = 2;\n', 'const y');
                assert.strictEqual(one.length, 1);
                assert.strictEqual(one[0].line, 2);
        });

        test('reports every occurrence when the text repeats', () => {
                const hits = locate(sample, 'return 1;');
                assert.strictEqual(hits.length, 2);
                assert.deepStrictEqual(hits.map(h => h.line), [2, 6]);
        });

        test('returns nothing for an empty needle', () => {
                assert.deepStrictEqual(locate(sample, ''), []);
        });

        test('context shows the surrounding lines', () => {
                const hits = locate(sample, 'return 1;');
                assert.ok(hits[0].context.includes('function alpha'));
        });

        test('replaces a single occurrence and leaves the rest', () => {
                const out = replaceOnce(sample, 'return 1;', 'return 42;');
                assert.ok(out.includes('return 42;'));
                assert.ok(out.includes('return 1;'));
        });

        test('replaces every occurrence when asked', () => {
                const { text, count } = replaceAll(sample, 'return 1;', 'return 42;');
                assert.strictEqual(count, 2);
                assert.ok(!text.includes('return 1;'));
        });

        test('handles a replacement containing the needle', () => {
                const { text, count } = replaceAll('aa', 'a', 'aaa');
                assert.strictEqual(count, 2);
                assert.strictEqual(text, 'aaaaaa');
        });

        test('handles multi-line needles and CRLF files', () => {
                const crlf = 'a\r\nb\r\nc';
                const hits = locate(crlf, 'b\r\n');
                assert.strictEqual(hits.length, 1);
                assert.strictEqual(hits[0].line, 2);
        });

        test('a no-op replacement is still reported as one match', () => {
                const hits = locate(sample, 'return 1;');
                assert.strictEqual(hits.length, 2);
        });
});
