import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';
import { registerAdvancedTools } from '../tools/advanced-tools';
import { recordToolCall, setRegisteredTools, getNeverCalledTools, getNeverCalledCount } from '../utils/usage';
import { detectRuntimeFacts } from '../utils/runtime-facts';
import type { Context } from 'mocha';
import { TOOL_HINTS } from '../utils/tool-annotations';

const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

function groupsWith(overrides: Partial<ToolConfiguration>): ToolConfiguration {
        return { ...ALL_GROUPS_ON, ...overrides } as ToolConfiguration;
}

async function registerAndList(config: ToolConfiguration): Promise<string[]> {
        const host = new MCPServer(3400, '127.0.0.1', undefined, config);
        host.setFileListingCallback(async () => []);
        const inner = new McpServer({ name: 'usage', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
        register(inner);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([inner.connect(st), client.connect(ct)]);
        try {
                return (await client.listTools()).tools.map(t => t.name);
        } finally {
                await client.close();
                await inner.close();
        }
}

type HandlerResult = { content?: Array<{ type: string; text?: string }> };
type ToolHandler = () => Promise<HandlerResult>;

async function serverInfoText(): Promise<string> {
        let captured: ToolHandler | undefined;
        const probe = {
                tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
                        if (name === 'get_server_info_code') {
                                captured = handler;
                        }
                }
        } as unknown as McpServer;

        registerAdvancedTools(probe, { host: '127.0.0.1', port: 3400 });
        assert.ok(captured, 'get_server_info_code handler was not registered');
        const result = await (captured as ToolHandler)();
        return (result.content ?? []).map(c => c.text ?? '').join('\n');
}

suite('registered tools that were never called', function () {
        suiteSetup(async function (this: Context) {
                this.timeout(15000);
                await detectRuntimeFacts();
        });

        teardown(() => {
                setRegisteredTools([]);
        });

        test('a called tool drops out and an untouched one stays', () => {
                setRegisteredTools(['alpha_code', 'beta_code', 'gamma_code']);
                recordToolCall('beta_code');

                const never = getNeverCalledTools(10);
                assert.ok(!never.includes('beta_code'), 'a called tool must not be reported as never called');
                assert.deepStrictEqual(never, ['alpha_code', 'gamma_code']);
                assert.strictEqual(getNeverCalledCount(), 2);
        });

        test('the count is the registered set minus the distinct called ones', () => {
                const catalog = ['a_code', 'b_code', 'c_code', 'd_code', 'e_code'];
                setRegisteredTools(catalog);
                recordToolCall('a_code');
                recordToolCall('a_code');
                recordToolCall('c_code');

                const distinctCalled = new Set(['a_code', 'c_code']).size;
                assert.strictEqual(getNeverCalledCount(), catalog.length - distinctCalled);
                assert.strictEqual(getNeverCalledTools(99).length, getNeverCalledCount());
        });

        test('an empty catalog reports nothing instead of failing', () => {
                setRegisteredTools([]);
                assert.strictEqual(getNeverCalledCount(), 0);
                assert.deepStrictEqual(getNeverCalledTools(20), []);
        });

        test('registration feeds the whole tool set, not the groups registered so far', async () => {
                const names = await registerAndList(ALL_GROUPS_ON);

                assert.ok(
                        names.includes('ocr_pdf_code') && names.includes('package_skill_code'),
                        'the catalog must include groups registered after advanced, or this test proves nothing'
                );
                assert.strictEqual(getNeverCalledCount(), names.length);
                assert.strictEqual(getNeverCalledTools(500).length, names.length);
        });

        test('the catalog follows the registry, not the static hint list', async () => {
                const names = await registerAndList(groupsWith({ ocr: false }));
                const never = getNeverCalledTools(500);

                for (const ocrTool of ['ocr_pdf_code', 'render_pdf_pages_code', 'pdf_needs_ocr_code']) {
                        assert.ok(ocrTool in TOOL_HINTS, `${ocrTool} must exist in TOOL_HINTS, or the test is vacuous`);
                        assert.ok(!names.includes(ocrTool), `${ocrTool} must be unregistered when the ocr group is off`);
                        assert.ok(!never.includes(ocrTool), `${ocrTool} must not appear in the catalog`);
                }
                assert.strictEqual(never.length, names.length);
        });

        test('server info states the count and lists the tools alphabetically', async () => {
                setRegisteredTools(['zzz_code', 'aaa_code', 'mmm_code']);

                const text = await serverInfoText();

                assert.ok(
                        text.includes('(3): aaa_code, mmm_code, zzz_code'),
                        `must state the count and list alphabetically:\n${text}`
                );
        });

        test('server info omits the line when every registered tool has been called', async () => {
                setRegisteredTools(['only_code']);
                recordToolCall('only_code');

                const text = await serverInfoText();

                assert.ok(text.includes('Server status'), `server info must still render:\n${text}`);
                assert.ok(
                        !text.includes('never called'),
                        `nothing is missing, so the line must be absent:\n${text}`
                );
        });
});