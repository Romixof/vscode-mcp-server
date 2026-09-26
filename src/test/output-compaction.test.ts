import * as assert from 'assert';
import { compactCommandOutput } from '../utils/token-efficiency';

const FOLDABLE = Array.from({ length: 2000 }, (_, i) => `distinct output line ${i}`).join('\n');

function pairFoldedAndUnfolded(command: string, output: string): { single: string; chained: string } {
        return {
                single: compactCommandOutput(command, output).text,
                chained: compactCommandOutput(`${command} && ${command}`, output).text
        };
}

suite('output compaction', () => {
        test('a chain is not folded, while the same command alone still is', () => {
                const command = 'python generate_pdf.py --md report.md';
                const { single, chained } = pairFoldedAndUnfolded(command, FOLDABLE);
                assert.ok(single.length < FOLDABLE.length, 'the single statement must fold');
                assert.strictEqual(chained, FOLDABLE, 'adding && must switch folding off');
        });

        test('a long chain keeps every statement attributable', () => {
                const statements = Array.from({ length: 12 }, (_, i) => `step ${i} wrote notes-${i}.pdf`);
                const output = statements.join('\n');
                const command = statements.map((_, i) => `python generate_pdf.py --md notes-${i}.md`).join(' && ');
                const result = compactCommandOutput(command, output);
                for (const line of statements) {
                        assert.ok(result.text.includes(line), `a chain must keep "${line}"`);
                }
                assert.ok(result.strategy.startsWith('skipped'), `expected a skip strategy, got ${result.strategy}`);
                assert.strictEqual(result.compactChars, result.originalChars, 'a chain must report no saving');
        });

        test('a pipe inside a chained command cannot hide a statement', () => {
                const output = 'PDF genere : Notes - Energie.pdf\nPDF genere : Synthese - Energie.pdf';
                const result = compactCommandOutput('python a.py 2>&1 | tail -30 && python b.py 2>&1 | tail -30', output);
                assert.ok(/Notes - Energie\.pdf/.test(result.text), 'the first statement must survive');
                assert.ok(/Synthese - Energie\.pdf/.test(result.text), 'the second statement must survive');
        });

        test('every statement separator disables folding', () => {
                for (const separator of ['&&', '||', ';']) {
                        const chained = compactCommandOutput(`python a.py ${separator} python b.py`, FOLDABLE);
                        assert.strictEqual(chained.text, FOLDABLE, `separator ${separator} must disable folding`);
                }
        });

        test('a lone pipe stays one statement and keeps folding', () => {
                const result = compactCommandOutput('python generate_pdf.py --md a.md 2>&1 | tail -30', FOLDABLE);
                assert.ok(result.text.length < FOLDABLE.length, 'a pipeline is a single stream and must still fold');
                assert.ok(!result.strategy.startsWith('skipped'), `a pipeline must fold, got ${result.strategy}`);
        });

        test('a separator inside quotes costs folding but never loses output', () => {
                const result = compactCommandOutput("grep -E 'a&&b' notes.txt", FOLDABLE);
                assert.strictEqual(result.text, FOLDABLE, 'a false positive must return the full output, never a wrong subset');
        });

        test('a chain that would never have folded is still returned whole', () => {
                const output = 'ok';
                assert.strictEqual(compactCommandOutput('a && b', output).text, output);
        });

        test('repeats collapse for a single statement and the count is stated', () => {
                const result = compactCommandOutput('python a.py', 'line\n'.repeat(10));
                assert.ok(result.text.length < 50, 'ten identical lines must fold');
                assert.ok(/×10 repeat/.test(result.text), `the fold must state the count: ${result.text}`);
        });

        test('a tiny output is returned as-is', () => {
                assert.strictEqual(compactCommandOutput('python a.py', 'ok').text, 'ok');
        });
});
