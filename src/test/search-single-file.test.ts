import * as assert from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerSearchTools } from '../tools/search-tools';

const FILE_BODY = [
        'alpha line',
        'target one',
        'beta line',
        'target two',
        'gamma line'
].join('\n');

async function search(root: string, args: Record<string, unknown>): Promise<string> {
        const inner = new McpServer({ name: 'search', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        registerSearchTools(inner, (inputPath: string) => join(root, inputPath));
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([inner.connect(st), client.connect(ct)]);
        try {
                const result = await client.callTool({ name: 'search_workspace_code', arguments: args });
                const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
                return content.map(c => c.text ?? '').join('\n');
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('search_workspace_code on a file path', () => {
        let root: string;

        setup(() => {
                root = mkdtempSync(join(tmpdir(), 'mcp-search-'));
                mkdirSync(join(root, 'sub'));
                writeFileSync(join(root, 'notes.md'), FILE_BODY, 'utf8');
                writeFileSync(join(root, 'sub', 'other.md'), 'target three\n', 'utf8');
                writeFileSync(join(root, 'code.py'), 'target python\n', 'utf8');
        });

        teardown(() => {
                rmSync(root, { recursive: true, force: true });
        });

        test('a named file is searched instead of refused', async () => {
                const text = await search(root, { pattern: 'target', path: 'notes.md' });
                assert.ok(!/isError/.test(text), `the file path must not be refused: ${text}`);
                assert.ok(!/not supported/.test(text), `the old refusal must be gone: ${text}`);
                assert.ok(/target one/.test(text) && /target two/.test(text), `both lines must be found: ${text}`);
                assert.ok(!/target three/.test(text), 'only the named file may be searched');
                assert.ok(!/target python/.test(text), 'only the named file may be searched');
        });

        test('a glob cannot hide the file the caller named', async () => {
                const text = await search(root, { pattern: 'target', path: 'notes.md', glob: '*.py' });
                assert.ok(/target one/.test(text), `an explicit file must survive a mismatched glob: ${text}`);
                assert.ok(!/\(glob:/.test(text), 'the glob must not be echoed when it was ignored');
        });

        test('the header names the file that was searched', async () => {
                const text = await search(root, { pattern: 'target', path: 'notes.md' });
                assert.ok(new RegExp(`in ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]notes\\.md`).test(text), `the header must name the file: ${text}`);
        });

        test('a directory still walks and still honours the glob', async () => {
                const all = await search(root, { pattern: 'target' });
                assert.ok(/target one/.test(all) && /target three/.test(all) && /target python/.test(all), `a directory search must recurse: ${all}`);

                const filtered = await search(root, { pattern: 'target', glob: '*.py' });
                assert.ok(/target python/.test(filtered), `a directory search must keep honouring the glob: ${filtered}`);
                assert.ok(!/target one/.test(filtered), 'the glob must filter a directory search');
        });

        test('a nested file is reachable by its own path', async () => {
                const text = await search(root, { pattern: 'target', path: 'sub/other.md' });
                assert.ok(/target three/.test(text), `a nested file must be searchable: ${text}`);
                assert.ok(!/target one/.test(text), 'only the named file may be searched');
        });

        test('a missing path is still an error', async () => {
                const text = await search(root, { pattern: 'target', path: 'nope.md' });
                assert.ok(/does not exist/.test(text), `a missing path must be reported: ${text}`);
        });

        test('a file with no match reports zero, not an error', async () => {
                const text = await search(root, { pattern: 'zzz-not-present', path: 'notes.md' });
                assert.ok(/0 match\(es\)/.test(text), `a clean miss must be reported as zero: ${text}`);
        });
});
