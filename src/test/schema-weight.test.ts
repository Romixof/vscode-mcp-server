import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';

const PAYLOAD_BUDGET_TOKENS = 26500;
const WORKSPACE_DESC_MAX_CHARS = 90;
const MAMMOTH_PER_TOOL_CAP = 32768;

const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

interface ListedTool {
        name: string;
        description?: string;
        inputSchema: { properties?: Record<string, { description?: string }> };
}

async function fetchToolList(): Promise<ListedTool[]> {
        const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_GROUPS_ON);
        host.setFileListingCallback(async () => []);
        const inner = new McpServer({ name: 'vscode-mcp-server', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
        register(inner);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'schema-weight', version: '1.0.0' }, { capabilities: {} });
        await Promise.all([inner.connect(serverTransport), client.connect(clientTransport)]);
        try {
                const result = await client.listTools();
                return result.tools as unknown as ListedTool[];
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('tools/list payload budget', () => {
        test('the whole tool list stays under the token budget', async () => {
                const tools = await fetchToolList();
                const tokens = Math.round(JSON.stringify(tools).length / 4);
                console.log(`  tools: ${tools.length}, payload ~${tokens} tok`);
                assert.ok(tokens <= PAYLOAD_BUDGET_TOKENS, `payload ${tokens} tok exceeds ${PAYLOAD_BUDGET_TOKENS}`);
        });

        test('the repeated workspace parameter description stays short', async () => {
                const tools = await fetchToolList();
                const withWorkspace = tools.filter(t => t.inputSchema.properties?.workspace?.description);
                const perTool = withWorkspace[0]?.inputSchema.properties?.workspace?.description?.length ?? 0;
                console.log(`  workspace: ${perTool} chars x ${withWorkspace.length} tools ~${Math.round(perTool * withWorkspace.length / 4)} tok`);
                assert.ok(withWorkspace.length > 50, 'expected the workspace param on most tools');
                assert.ok(perTool <= WORKSPACE_DESC_MAX_CHARS, `workspace description ${perTool} chars, budget ${WORKSPACE_DESC_MAX_CHARS}`);
        });

        test('no single tool exceeds the per-tool schema cap', async () => {
                const tools = await fetchToolList();
                for (const t of tools) {
                        const size = JSON.stringify(t).length;
                        assert.ok(size < MAMMOTH_PER_TOOL_CAP, `${t.name} is ${size} chars, cap ${MAMMOTH_PER_TOOL_CAP}`);
                }
        });
});
