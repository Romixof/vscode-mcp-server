import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';
import { TOOL_HINTS } from '../utils/tool-annotations';

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
