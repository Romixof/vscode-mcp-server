import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServer, ToolConfiguration } from '../../server';

export interface ListedTool {
        name: string;
        description?: string;
        inputSchema: {
                properties?: Record<string, { description?: string; type?: string; enum?: string[]; default?: unknown }>;
                required?: string[];
        };
}

export const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

export async function fetchToolList(): Promise<ListedTool[]> {
        const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_GROUPS_ON);
        host.setFileListingCallback(async () => []);
        const inner = new McpServer({ name: 'vscode-mcp-server', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
        register(inner);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'payload', version: '1.0.0' }, { capabilities: {} });
        await Promise.all([inner.connect(serverTransport), client.connect(clientTransport)]);
        try {
                const result = await client.listTools();
                return result.tools as unknown as ListedTool[];
        } finally {
                await client.close();
                await inner.close();
        }
}
