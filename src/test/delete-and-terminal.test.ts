import * as assert from 'assert';
import * as path from 'path';
import proxyquire from 'proxyquire';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Minimal vscode stand-in shared by the modules under test.
function fakeVscode(root: string, files: Record<string, 'file' | 'dir'>, answer: string | undefined) {
        const deleted: Array<{ fsPath: string; recursive?: boolean; useTrash?: boolean }> = [];
        const asked: string[] = [];
        const uri = (p: string) => ({ fsPath: path.resolve(p), path: path.resolve(p).replace(/\\/g, '/'), scheme: 'file', toString: () => path.resolve(p) });
        const vscode = {
                '@noCallThru': true,
                '@global': true,
                Uri: {
                        file: uri,
                        joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts))
                },
                FileType: { File: 1, Directory: 2 },
                workspace: {
                        workspaceFolders: [{ name: 'proj', index: 0, uri: uri(root) }],
                        getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
                        fs: {
                                stat: async (u: { fsPath: string }) => {
                                        const kind = files[path.relative(root, u.fsPath).replace(/\\/g, '/')];
                                        if (!kind) { throw new Error('ENOENT'); }
                                        return { type: kind === 'dir' ? 2 : 1, size: 1, ctime: 0, mtime: 0 };
                                },
                                delete: async (u: { fsPath: string }, o: { recursive?: boolean; useTrash?: boolean }) => { deleted.push({ fsPath: u.fsPath, ...o }); }
                        }
                },
                window: {
                        terminals: [] as unknown[],
                        showWarningMessage: async (message: string) => { asked.push(message); return answer; },
                        createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined })
                }
        };
        return { vscode, deleted, asked };
}

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function loadDelete(root: string, files: Record<string, 'file' | 'dir'>, answer: string | undefined) {
        const fake = fakeVscode(root, files, answer);
        const mod = proxyquire('../tools/file-tools', { vscode: fake.vscode }) as { registerFileTools: (server: unknown, listing: unknown) => void };
        const handlers: Record<string, Handler> = {};
        const server = { tool: (name: string, ...rest: unknown[]) => { handlers[name] = rest[rest.length - 1] as Handler; } };
        mod.registerFileTools(server, async () => []);
        return { run: handlers['delete_file_code'], ...fake };
}

const text = (r: CallToolResult) => r.content.map(c => (c as { text?: string }).text ?? '').join('\n');

suite('delete_file_code', () => {
        const root = path.resolve('/tmp/mcp-delete-proj');

        test('deletes an approved file to the trash', async () => {
                const t = loadDelete(root, { 'a.txt': 'file' }, 'Delete');
                const r = await t.run({ path: 'a.txt', recursive: false });
                assert.ok(!r.isError, text(r));
                assert.strictEqual(t.asked.length, 1);
                assert.deepStrictEqual(t.deleted, [{ fsPath: path.join(root, 'a.txt'), recursive: false, useTrash: true }]);
        });

        test('a declined approval deletes nothing', async () => {
                const t = loadDelete(root, { 'a.txt': 'file' }, undefined);
                const r = await t.run({ path: 'a.txt', recursive: false });
                assert.ok(r.isError);
                assert.match(text(r), /declined/);
                assert.deepStrictEqual(t.deleted, []);
        });

        test('a path outside the workspace is refused before any prompt', async () => {
                const t = loadDelete(root, {}, 'Delete');
                await assert.rejects(async () => {
                        const r = await t.run({ path: path.resolve('/tmp/elsewhere.txt'), recursive: false });
                        if (r.isError) { throw new Error(text(r)); }
                });
                assert.deepStrictEqual(t.asked, []);
                assert.deepStrictEqual(t.deleted, []);
        });

        test('a directory needs recursive=true', async () => {
                const t = loadDelete(root, { sub: 'dir' }, 'Delete');
                const r = await t.run({ path: 'sub', recursive: false });
                assert.ok(r.isError);
                assert.match(text(r), /recursive=true/);
                assert.deepStrictEqual(t.asked, []);
        });

        test('the workspace root itself is refused', async () => {
                const t = loadDelete(root, {}, 'Delete');
                await assert.rejects(() => t.run({ path: root, recursive: true }), /workspace root/);
                assert.deepStrictEqual(t.deleted, []);
        });
});

suite('owned terminal', () => {
        interface FakeTerminal { name: string; exitStatus?: unknown; disposed?: boolean; dispose(): void }
        const term = (name: string): FakeTerminal => ({ name, dispose() { this.disposed = true; } });

        test('a terminal revived from an earlier session is replaced, not reused', () => {
                const revived = term('MCP Shell');
                const window = { terminals: [revived] as FakeTerminal[] };
                const mod = proxyquire('../utils/owned-terminal', { vscode: { '@noCallThru': true, window } }) as { ownedTerminal(name: string, create: () => FakeTerminal): FakeTerminal };
                const created: FakeTerminal[] = [];
                const first = mod.ownedTerminal('MCP Shell', () => { const t = term('MCP Shell'); created.push(t); window.terminals.push(t); return t; });
                assert.strictEqual(revived.disposed, true);
                assert.strictEqual(created.length, 1);
                assert.strictEqual(first, created[0]);
                const again = mod.ownedTerminal('MCP Shell', () => { throw new Error('must reuse'); });
                assert.strictEqual(again, first);
        });
});
