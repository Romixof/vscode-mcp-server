import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listWorkspaceFiles } from '../tools/file-tools';

suite('listing walk integration', () => {
        let root: string;

        suiteSetup(() => {
                root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listing-'));
                fs.mkdirSync(path.join(root, '__pycache__'));
                fs.writeFileSync(path.join(root, '__pycache__', 'x.pyc'), 'noise');
                fs.mkdirSync(path.join(root, 'node_modules'));
                fs.writeFileSync(path.join(root, 'node_modules', 'p.js'), 'noise');
                fs.mkdirSync(path.join(root, 'src'));
                fs.writeFileSync(path.join(root, 'src', 'keep.ts'), 'x'.repeat(1500));
                fs.writeFileSync(path.join(root, 'top.md'), '# hello');
        });

        suiteTeardown(() => {
                fs.rmSync(root, { recursive: true, force: true });
        });

        test('the walk really skips build noise', async () => {
                const entries = await listWorkspaceFiles(root, true);
                const paths = entries.map(e => e.path);
                assert.ok(!paths.some(p => p.includes('__pycache__')), `__pycache__ leaked: ${paths.join(', ')}`);
                assert.ok(!paths.some(p => p.includes('node_modules')), `node_modules leaked: ${paths.join(', ')}`);
                assert.ok(paths.some(p => p.endsWith('keep.ts')), 'a real file must survive');
        });

        test('the walk really reports size for a file', async () => {
                const entries = await listWorkspaceFiles(root, true);
                const keep = entries.find(e => e.path.endsWith('keep.ts'));
                assert.ok(keep, 'keep.ts missing');
                assert.strictEqual(keep!.size, 1500, `size not collected: ${JSON.stringify(keep)}`);
        });

        test('the walk really reports a modification time', async () => {
                const entries = await listWorkspaceFiles(root, false);
                const top = entries.find(e => e.path.endsWith('top.md'));
                assert.ok(top, 'top.md missing');
                assert.ok(typeof top!.modified === 'number' && top!.modified > 0, `mtime not collected: ${JSON.stringify(top)}`);
        });

        test('a directory carries no size', async () => {
                const entries = await listWorkspaceFiles(root, false);
                const dir = entries.find(e => e.type === 'directory');
                assert.ok(dir, 'no directory found');
                assert.strictEqual(dir!.size, undefined);
        });
});
