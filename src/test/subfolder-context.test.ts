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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-subfolder-'));
const wsRoot = path.join(stateDir, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

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
                                writeFile: async (uri: string | { fsPath: string }, data: Uint8Array): Promise<void> => {
                                        const p = asUri(uri);
                                        fs.mkdirSync(path.dirname(p), { recursive: true });
                                        fs.writeFileSync(p, Buffer.from(data));
                                },
                                createDirectory: async (_uri: string | { fsPath: string }): Promise<void> => {},
                                readDirectory: async (uri: string | { fsPath: string }): Promise<Array<[string, number]>> => {
                                        const p = asUri(uri);
                                        if (!fs.existsSync(p)) {
                                                const e = new StubFsError(`ENOENT: ${p}`);
                                                e.code = 'FileNotFound';
                                                throw e;
                                        }
                                        return fs.readdirSync(p, { withFileTypes: true })
                                                .map(d => [d.name, d.isDirectory() ? 2 : 0] as [string, number]);
                                }
                        }
                },
                FileType: { Directory: 2, File: 0 },
                FileSystemError: StubFsError,
                Uri: { file: (p: string) => ({ fsPath: p }) }
        };
}

const FAKE_FOLDER = { name: 'subfolder-test', index: 0, uri: { fsPath: wsRoot } };
const workspaceStub = {
        listWorkspaceFolders: () => [FAKE_FOLDER],
        resolveWorkspaceFolder: () => FAKE_FOLDER
};

const stateModule = proxyquire('../utils/workspace-state', {
        './workspace': workspaceStub,
        'vscode': vscodeStub()
}) as unknown as typeof import('../utils/workspace-state');

const vscodeStubShared = vscodeStub();
const advanced = proxyquire('../tools/advanced-tools', {
        'vscode': vscodeStubShared,
        './memory-tools': {
                loadAllMemory: async (_w: unknown, subfolder?: string) => ({
                        global: null,
                        project: null,
                        projectPath: stateModule.projectMemoryPath(undefined, subfolder)
                })
        },
        '../utils/workspace': workspaceStub,
        '../utils/workspace-state': stateModule
}) as unknown as typeof import('../tools/advanced-tools');

const agentInstructions = proxyquire('../utils/agent-instructions', {}) as unknown as typeof import('../utils/agent-instructions');

suite('per-subfolder topic context', () => {

        test('normalizeSubfolder accepts relative paths and rejects escapes', () => {
                assert.strictEqual(stateModule.normalizeSubfolder(undefined), undefined);
                assert.strictEqual(stateModule.normalizeSubfolder(''), undefined);
                assert.strictEqual(stateModule.normalizeSubfolder('  '), undefined);
                assert.strictEqual(stateModule.normalizeSubfolder('Synthèse/Histoire'), path.join('Synthèse', 'Histoire'));
                assert.strictEqual(stateModule.normalizeSubfolder('a\\b'), path.join('a', 'b'));
                assert.strictEqual(stateModule.normalizeSubfolder('./x'), path.join('x'));
                assert.throws(() => stateModule.normalizeSubfolder('..'), /Invalid subfolder/);
                assert.throws(() => stateModule.normalizeSubfolder('a/../..'), /Invalid subfolder/);
                assert.throws(() => stateModule.normalizeSubfolder('C:/temp'), /Invalid subfolder/);
                assert.throws(() => stateModule.normalizeSubfolder('/etc'), /Invalid subfolder/);
        });

        test('state, log and memory paths live under <subfolder>/.mammouth/', () => {
                const statePath = stateModule.projectStatePath(undefined, 'Synthèse/Histoire');
                const logPath = stateModule.projectLogPath(undefined, 'Synthèse/Histoire');
                assert.ok(statePath && statePath.startsWith(path.join(wsRoot, 'Synthèse', 'Histoire', '.mammouth')), `state under the topic dir: ${statePath}`);
                assert.ok(path.basename(statePath!) === 'STATE.md', `topic state is not name-prefixed: ${statePath}`);
                assert.ok(logPath && path.basename(logPath!) === 'LOG.md', `topic log: ${logPath}`);
                // Without subfolder the legacy workspace-root naming still applies.
                assert.ok(stateModule.projectStatePath()!.endsWith('subfolder-test_STATE.md'));
        });

        test('workspace_state_code writes into the topic subfolder and handoff_code reads it back', async () => {
                const memoryTools = proxyquire('../tools/memory-tools', {
                        '../utils/workspace': workspaceStub,
                        '../utils/workspace-state': stateModule
                }) as unknown as typeof import('../tools/memory-tools');
                const handlers = captureTools(memoryTools.registerMemoryTools);
                const state = handlers.get('workspace_state_code');
                const handoff = handlers.get('handoff_code');
                assert.ok(state && handoff, 'state/handoff tools were not registered');

                const write = firstText(await state({
                        action: 'write',
                        status: 'cours terminé',
                        nextStep: 'relire le chapitre 3',
                        subfolder: 'Synthèse/Histoire'
                }));
                assert.ok(/✅/.test(write), `write acknowledged: ${write}`);
                const topicState = path.join(wsRoot, 'Synthèse', 'Histoire', '.mammouth', 'STATE.md');
                assert.ok(fs.existsSync(topicState), `the topic state file exists at ${topicState}`);
                assert.ok(!fs.existsSync(path.join(wsRoot, 'subfolder-test_STATE.md')), 'the root state file stays untouched');

                const read = firstText(await handoff({ action: 'read', subfolder: 'Synthèse/Histoire' }));
                assert.ok(/Next step: relire le chapitre 3/.test(read), `handoff reads the topic state: ${read}`);
        });

        test('memory_save_code and memory_search_code scope to the topic subfolder', async () => {
                const memoryTools = proxyquire('../tools/memory-tools', {
                        '../utils/workspace': workspaceStub,
                        '../utils/workspace-state': stateModule
                }) as unknown as typeof import('../tools/memory-tools');
                const handlers = captureTools(memoryTools.registerMemoryTools);
                const save = handlers.get('memory_save_code');
                const search = handlers.get('memory_search_code');
                assert.ok(save && search, 'memory tools were not registered');

                const out = firstText(await save({
                        section: 'Révisions',
                        entry: 'Chapitre 3 terminé le 11/10',
                        scope: 'project',
                        subfolder: 'Synthèse/Histoire'
                }));
                assert.ok(/Saved to project memory/.test(out), `save acknowledged: ${out}`);
                const topicMemory = path.join(wsRoot, 'Synthèse', 'Histoire', '.mammouth', 'MEMORY.md');
                assert.ok(fs.existsSync(topicMemory), `the topic memory file exists at ${topicMemory}`);

                const found = firstText(await search({ query: 'Chapitre 3', scope: 'project', subfolder: 'Synthèse/Histoire' }));
                assert.ok(/1 match\(es\)/.test(found), `the topic memory is searchable: ${found}`);
                const otherTopic = firstText(await search({ query: 'Chapitre 3', scope: 'project', subfolder: 'Synthèse/Géographie' }));
                assert.ok(/No matches found/.test(otherTopic), `a sibling topic does not see the entry: ${otherTopic}`);
        });

        test('bootstrap with a subfolder lists THAT folder and points at its topic files', async () => {
                fs.mkdirSync(path.join(wsRoot, 'Synthèse', 'Histoire'), { recursive: true });
                fs.writeFileSync(path.join(wsRoot, 'Synthèse', 'Histoire', 'chapitre-3.md'), '# Histoire\n');
                const handlers = captureTools(s => advanced.registerSessionBootstrapTool(s, () => undefined));
                const boot = handlers.get('session_bootstrap_code');
                assert.ok(boot, 'session_bootstrap_code was not registered');

                const out = firstText(await boot({ sections: ['memory', 'layout'], subfolder: 'Synthèse/Histoire' }));
                assert.ok(/Folder "Synthèse\\Histoire"/.test(out), `the layout lists the topic folder: ${out.slice(0, 600)}`);
                assert.ok(/chapitre-3\.md/.test(out), `the topic contents are listed: ${out.slice(0, 600)}`);
                assert.ok(!/Root of "/.test(out), `the root listing must not leak into a topic bootstrap: ${out.slice(0, 600)}`);
                assert.ok(/subfolder="Synthèse\\Histoire"/.test(out), `the empty-memory hint passes the subfolder through: ${out.slice(0, 800)}`);
        });
});

suite('v24 guide rules', () => {

        test('the workflow re-anchors on every user message, compact by default', () => {
                const rules = agentInstructions.resolveAgentInstructions();
                assert.ok(/EVERY user message opens with session_bootstrap_code\(\)/.test(rules), `rule 1 re-anchors each message: ${rules.slice(0, 600)}`);                                assert.ok(/default mode="compact"/.test(rules), `compact is the default: ${rules.slice(0, 600)}`);
                                assert.ok(/Escalate ONLY if the task needs more: mode="full"/.test(rules), `full is the opt-in escalation: ${rules.slice(0, 600)}`);
                assert.ok(/subfolder="/.test(rules), `rule 1 teaches the topic subfolder: ${rules.slice(0, 600)}`);
        });

        test('the workflow demands a handoff before any reply that leaves work pending', () => {
                const rules = agentInstructions.resolveAgentInstructions();
                assert.ok(/Never stop with work pending/.test(rules), `rule 7 blocks bare stops: ${rules.slice(0, 1200)}`);
                assert.ok(/handoff_code\(inProgress, lastTool, nextStep\)/.test(rules), `rule 7 names the handoff call: ${rules.slice(0, 1200)}`);
                assert.ok(/session_end_code\(summary/.test(rules), `finished work still closes with session_end_code: ${rules.slice(0, 1200)}`);
        });

        test('the guide version moved to 25', () => {
                assert.strictEqual(agentInstructions.AGENT_INSTRUCTIONS_VERSION, '27');
        });
});
