import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTextMatches, applyTextReplacement } from '../tools/edit-tools';
import { diffPreviewForEdit } from '../utils/edit-preview';

async function withTempFile<T>(name: string, content: string, fn: (uri: vscode.Uri) => Promise<T>): Promise<T> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-edit-'));
        const file = path.join(dir, name);
        fs.writeFileSync(file, content, 'utf-8');
        try {
                return await fn(vscode.Uri.file(file));
        } finally {
                fs.rmSync(dir, { recursive: true, force: true });
        }
}

suite('edit_file_code', () => {
        test('a unique match is replaced', async () => {
                await withTempFile('a.ts', 'const x = 1;\nconst y = 2;\n', async uri => {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const changed = await applyTextReplacement(doc, 'const y = 2;', 'const y = 3;', false);
                        assert.strictEqual(changed, 1);
                        assert.ok(doc.getText().includes('const y = 3;'));
                });
        });

        test('an ambiguous match is reported, not applied', () => {
                const content = 'return 1;\nreturn 1;\n';
                const hits = findTextMatches(content, 'return 1;');
                assert.strictEqual(hits.length, 2);
                assert.deepStrictEqual(hits.map(h => h.line), [1, 2]);
        });

        test('replace_all changes every occurrence', async () => {
                await withTempFile('b.ts', 'x\nx\nx\n', async uri => {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const changed = await applyTextReplacement(doc, 'x', 'y', true);
                        assert.strictEqual(changed, 3);
                        assert.ok(!doc.getText().includes('x'));
                });
        });

        test('a missing match yields zero hits', () => {
                assert.deepStrictEqual(findTextMatches('hello', 'nope'), []);
        });

        test('an empty needle yields zero hits rather than looping forever', () => {
                assert.deepStrictEqual(findTextMatches('hello', ''), []);
        });

        test('matches survive surrounding whitespace being significant', () => {
                const content = 'if (a) {\n    b();\n}';
                assert.strictEqual(findTextMatches(content, '    b();').length, 1);
                assert.strictEqual(findTextMatches(content, 'b();').length, 1);
        });

        test('a replacement containing the old string is handled', () => {
                const hits = findTextMatches('aaa', 'aa');
                assert.strictEqual(hits.length, 1);
        });

        test('the edit is a no-op when old and new are identical', () => {
                const before = 'same';
                const preview = diffPreviewForEdit('f.ts', before, before);
                assert.ok(preview.includes('No change'));
        });

        test('the preview points at the changed line', () => {
                const before = 'a\nb\nc\n';
                const after = 'a\nB\nc\n';
                const preview = diffPreviewForEdit('f.ts', before, after);
                assert.ok(preview.includes('line 2'), preview);
                assert.ok(preview.includes('- 2'), preview);
                assert.ok(preview.includes('+ 2'), preview);
        });
});
