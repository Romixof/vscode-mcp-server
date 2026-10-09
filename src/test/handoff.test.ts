import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import proxyquire from 'proxyquire';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content?: Array<{ type: string; text?: string }> }>;

function captureTools(register: (server: McpServer) => void): Map<string, ToolHandler> {
        const handlers = new Map<string, ToolHandler>();
        const fakeServer = {
                tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
                        handlers.set(name, handler);
                }
        } as unknown as McpServer;
        register(fakeServer);
        return handlers;
}

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
        const block = (result.content ?? []).find(c => c.type === 'text');
        assert.ok(block && block.type === 'text', 'the tool returned no text block');
        return block.text ?? '';
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-handoff-'));
const wsRoot = path.join(stateDir, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

// A minimal fs-backed vscode stub: the state helpers only use
// workspace.fs.read/writeFile/createDirectory and Uri.file. Missing files must
// surface as a FileNotFound FileSystemError — that is the sentinel readTextFile
// converts into null, matching the real API.
function vscodeStub() {
        const asUri = (p: string | { fsPath: string }): string => typeof p === 'string' ? p : p.fsPath;
        class StubFsError extends Error {
                code: string = 'Unknown';
        }
        return {
                workspace: {
                        fs: {
                                readFile: async (uri: string | { fsPath: string }): Promise<Uint8Array> => {
                                        const p = asUri(uri);
                                        if (!fs.existsSync(p)) {
                                                const e = new StubFsError(`ENOENT: ${p}`);
                                                e.code = 'FileNotFound';
                                                throw e;
                                        }
                                        return new Uint8Array(Buffer.from(fs.readFileSync(p)));
                                },
                                writeFile: async (uri: string | { fsPath: string }, data: Uint8Array): Promise<void> => { fs.writeFileSync(asUri(uri), Buffer.from(data)); },
                                createDirectory: async (_uri: string | { fsPath: string }): Promise<void> => {}
                        }
                },
                FileType: { Directory: 2, File: 0 },
                FileSystemError: StubFsError,
                Uri: { file: (p: string) => ({ fsPath: p }) }
        };
}

const FAKE_FOLDER = { name: 'handoff-test', index: 0, uri: { fsPath: wsRoot } };

// Hermetic: the state-file helpers read the real VS Code workspace list, which is
// empty in a test run. The stub pins exactly one folder for every module under
// test, and the vscode shim routes all file I/O onto the real fs.
const workspaceStub = {
        listWorkspaceFolders: () => [FAKE_FOLDER],
        resolveWorkspaceFolder: () => FAKE_FOLDER
};
function stateModule(): NodeJS.Module {
        return proxyquire('../utils/workspace-state', {
                './workspace': workspaceStub,
                'vscode': vscodeStub()
        });
}
const memoryTools = proxyquire('../tools/memory-tools', {
        '../utils/workspace': workspaceStub,
        '../utils/workspace-state': stateModule()
}) as unknown as typeof import('../tools/memory-tools');

suite('handoff_code merge semantics', () => {
        const stateFile = path.join(wsRoot, 'handoff-test_STATE.md');

        test('write fills blanks from the prior state and keeps untouched fields', async () => {
                const handlers = captureTools(memoryTools.registerMemoryTools);
                const handoff = handlers.get('handoff_code');
                assert.ok(handoff, 'handoff_code was not registered');

                await handoff({ inProgress: 'OCR budget rewrite', lastTool: 'edit_file_code' });
                assert.ok(fs.existsSync(stateFile), 'the state file was not written');
                const saved = fs.readFileSync(stateFile, 'utf-8');
                assert.ok(!saved.includes('undefined'), 'no undefined may leak into the state file');
                assert.ok(/In progress: OCR budget rewrite/.test(saved), `inProgress recorded: ${saved}`);
                assert.ok(/Next step: edit_file_code/.test(saved), `lastTool becomes the next step, re-derivable: ${saved}`);

                await handoff({ nextStep: 'compile and rerun suite' });
                const saved2 = fs.readFileSync(stateFile, 'utf-8');
                assert.ok(/In progress: OCR budget rewrite/.test(saved2), `earlier inProgress must survive a partial write: ${saved2}`);
                assert.ok(/Next step: compile and rerun suite/.test(saved2), `the new nextStep must replace the old: ${saved2}`);
        });

        test('lastTool is persisted as its own line even when nextStep is also given', async () => {
                const handlers = captureTools(memoryTools.registerMemoryTools);
                const handoff = handlers.get('handoff_code');
                assert.ok(handoff, 'handoff_code was not registered');

                await handoff({ nextStep: 'run the suite', lastTool: 'edit_file_code' });
                const saved = fs.readFileSync(stateFile, 'utf-8');
                assert.ok(/Last tool: edit_file_code/.test(saved), `lastTool must persist as its own line: ${saved}`);
                assert.ok(/Next step: run the suite/.test(saved), `an explicit nextStep must not be overwritten by lastTool: ${saved}`);

                // A later write that mentions neither field must keep both.
                await handoff({ status: 'tests green' });
                const saved2 = fs.readFileSync(stateFile, 'utf-8');
                assert.ok(/Last tool: edit_file_code/.test(saved2), `lastTool must survive an untouched partial write: ${saved2}`);
                assert.ok(/Next step: run the suite/.test(saved2), `nextStep must survive an untouched partial write: ${saved2}`);
        });

        test('read prints the file without writing it', async () => {
                const handlers = captureTools(memoryTools.registerMemoryTools);
                const handoff = handlers.get('handoff_code');
                assert.ok(handoff, 'handoff_code was not registered');
                const before = fs.readFileSync(stateFile, 'utf-8');
                const result = await handoff({ action: 'read' });
                assert.ok(/In progress/.test(firstText(result)), `read shows the state: ${firstText(result)}`);
                const after = fs.readFileSync(stateFile, 'utf-8');
                assert.strictEqual(after, before, 'a read must not touch the file');
        });
});

suite('session_bootstrap_code compact mode', () => {
        const stateFile = path.join(wsRoot, 'handoff-test_STATE.md');

        test('compact returns the state snapshot and a pointer, not the guide or layout', async () => {
                const advanced = proxyquire('../tools/advanced-tools', {
                        '../utils/workspace': workspaceStub,
                        '../utils/workspace-state': stateModule()
                }) as unknown as typeof import('../tools/advanced-tools');
                const handlers = captureTools(s => advanced.registerSessionBootstrapTool(s, () => undefined));
                const boot = handlers.get('session_bootstrap_code');
                assert.ok(boot, 'session_bootstrap_code was not registered');
                const text = firstText(await boot({ mode: 'compact' }));
                assert.ok(/Workspace state|No workspace state recorded/.test(text), `compact must carry the state snapshot or the pointer note: ${text.slice(0, 300)}`);
                assert.ok(!text.includes('FULL TOOL CATALOG'), `compact must not ship the guide: ${text.slice(0, 200)}`);
                assert.ok(!/Root of "/.test(text), `compact must not ship the root layout: ${text.slice(0, 200)}`);
                assert.ok(text.length < 2400, `compact must stay lean, got ${text.length} chars`);
                assert.ok(/call session_bootstrap_code\(\) with no arguments/.test(text), `compact must point back to the full call: ${text.slice(0, 400)}`);
        });

        test('a state file that exists but is blank reads as nothing recorded, not as an empty section', async () => {
                // The real transcript hit this: a whitespace file exists, readTextFile
                // returns '' (not null), and a plain ?? served an empty section header.
                fs.writeFileSync(stateFile, '   \n\n');
                const advanced = proxyquire('../tools/advanced-tools', {
                        '../utils/workspace': workspaceStub,
                        '../utils/workspace-state': stateModule()
                }) as unknown as typeof import('../tools/advanced-tools');
                const handlers = captureTools(s => advanced.registerSessionBootstrapTool(s, () => undefined));
                const boot = handlers.get('session_bootstrap_code');
                assert.ok(boot, 'session_bootstrap_code was not registered');
                const text = firstText(await boot({ mode: 'compact' }));
                assert.ok(/No workspace state recorded yet/.test(text), `a blank state file must serve the fallback note: ${text.slice(0, 300)}`);
                // And the real content must come back once the file means something again.
                fs.writeFileSync(stateFile, '# Workspace state\n\n- In progress: real value\n');
                const text2 = firstText(await boot({ mode: 'compact' }));
                assert.ok(/In progress: real value/.test(text2), `a real state must come through: ${text2.slice(0, 300)}`);
        });
});
