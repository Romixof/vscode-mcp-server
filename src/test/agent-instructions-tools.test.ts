import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';
import { TOOL_HINTS } from '../utils/tool-annotations';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../utils/agent-instructions';

const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

async function describedTool(name: string): Promise<string> {
        const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_GROUPS_ON);
        host.setFileListingCallback(async () => []);
        const inner = new McpServer({ name: 'guide', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
        register(inner);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([inner.connect(st), client.connect(ct)]);
        try {
                const found = (await client.listTools()).tools.find(t => t.name === name);
                assert.ok(found, `${name} is not registered`);
                return found.description ?? '';
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('agent guide tool-count claims', () => {
        test('the catalog size is derived from the registry, not typed by hand', async () => {
                assert.strictEqual(Object.keys(TOOL_HINTS).length, 91, 'registry size changed - update the guide tests');
        });

        test('the guide description claims the real tool count', async () => {
                const description = await describedTool('get_agent_instructions_code');
                const claimed = (description.match(/catalog of all (\d+) tools/) ?? [])[1];
                assert.ok(claimed, `description no longer states a count: ${description.slice(0, 160)}`);
                assert.strictEqual(
                        Number(claimed),
                        Object.keys(TOOL_HINTS).length,
                        `description claims ${claimed}, registry has ${Object.keys(TOOL_HINTS).length}`
                );
        });

        test('the retired count 85 appears nowhere in the description', async () => {
                const description = await describedTool('get_agent_instructions_code');
                assert.ok(
                        !/\b85\b/.test(description),
                        `description still mentions the retired count 85: ${description.slice(0, 200)}`
                );
        });
});

suite('a client list missing the opener still gets the guide', () => {
        test('read_file_code names both PDF readers, not just that a pointer exists', async () => {
                const description = await describedTool('read_file_code');
                assert.ok(description.includes('ocr_pdf_code'), `must name ocr_pdf_code: ${description}`);
                assert.ok(description.includes('render_pdf_pages_code'), `must name render_pdf_pages_code: ${description}`);
        });

        test('read_file_code points at the guide fallback, not only the opener', async () => {
                const description = await describedTool('read_file_code');
                assert.ok(
                        description.includes('get_agent_instructions_code'),
                        `must name the fallback when session_bootstrap_code is absent: ${description}`
                );
        });

        test('the guide tool describes itself as the fallback rather than deferring', async () => {
                const description = await describedTool('get_agent_instructions_code');
                assert.ok(
                        description.includes('session_bootstrap_code'),
                        `must still mention the opener: ${description}`
                );
                assert.ok(
                        /not in your callable list/i.test(description),
                        `must state the condition under which this tool is the way in: ${description}`
                );
        });

        test('the guide body carries the fallback in its opener, its budget rules and its recipes', () => {
                const opener = DEFAULT_AGENT_INSTRUCTIONS.split('\n')[0];
                assert.ok(opener.includes('get_agent_instructions_code'), `opener must name the fallback: ${opener}`);
                assert.ok(
                        DEFAULT_AGENT_INSTRUCTIONS.includes('or with ONE get_agent_instructions_code() call'),
                        'the tool-budget section must name the fallback'
                );
                assert.ok(
                        DEFAULT_AGENT_INSTRUCTIONS.includes('or get_agent_instructions_code() when that one is not callable'),
                        'the recipes must name the fallback'
                );
        });
});
