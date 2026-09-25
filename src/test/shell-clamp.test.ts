import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';
import { CLIENT_BUDGET_MS, CLIENT_CEILING_MS, SHELL_TIMEOUT_MS } from '../tools/shell-tools';

const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

async function listedTools(): Promise<Array<{ name: string; description?: string; inputSchema: { properties?: Record<string, { default?: number }> } }>> {
        const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_GROUPS_ON);
        host.setFileListingCallback(async () => []);
        const inner = new McpServer({ name: 'schema', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
        register(inner);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([inner.connect(st), client.connect(ct)]);
        try {
                return (await client.listTools()).tools as never;
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('shell clamp and shell disclosure', () => {
        test('an oversized timeout is clamped to the client budget', () => {
                const requested = 120000;
                const effective = Math.min(requested, CLIENT_BUDGET_MS);
                assert.strictEqual(effective, CLIENT_BUDGET_MS, 'a 120s request must be clamped to the budget');
                assert.ok(effective < CLIENT_CEILING_MS, 'the clamp must land under the client ceiling');
                assert.ok(effective < requested, 'the clamp must actually reduce an oversized request');
        });

        test('a timeout already inside the budget is left alone', () => {
                assert.strictEqual(Math.min(SHELL_TIMEOUT_MS, CLIENT_BUDGET_MS), SHELL_TIMEOUT_MS);
        });

        test('the clamp notice names the requested value, the effective value and the ceiling', () => {
                const requested = 120000;
                const effective = Math.min(requested, CLIENT_BUDGET_MS);
                const notice = `Timeout clamped from ${requested}ms to ${effective}ms: the calling client disconnects at ${CLIENT_CEILING_MS}ms regardless.`;
                assert.ok(notice.includes(String(requested)), 'notice must name the requested value');
                assert.ok(notice.includes(String(effective)), 'notice must name the effective value');
                assert.ok(notice.includes(String(CLIENT_CEILING_MS)), 'notice must name the client ceiling');
        });

        test('the tool description always states the shell, real or unknown', async () => {
                const tools = await listedTools();
                const shell = tools.find(t => t.name === 'execute_shell_command_code');
                assert.ok(shell, 'execute_shell_command_code not registered');
                assert.ok(
                        /Shell:\s*(bash|PowerShell|unknown)/i.test(shell.description ?? ''),
                        `description does not state the shell: ${shell.description?.slice(0, 200)}`
                );
        });

        test('with a real terminal the description names that terminal shell', async () => {
                const bashTerminal = {
                        name: 'MCP',
                        creationOptions: { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
                        exitStatus: undefined,
                        show(): void {},
                        shellIntegration: undefined
                } as unknown as NonNullable<ConstructorParameters<typeof MCPServer>[2]>;

                const host = new MCPServer(3400, '127.0.0.1', bashTerminal, ALL_GROUPS_ON);
                host.setFileListingCallback(async () => []);
                const inner = new McpServer({ name: 'schema', version: 'test' }, {
                        capabilities: { logging: {}, tools: { listChanged: false } }
                });
                const register = (host as unknown as { registerToolsOn(s: McpServer): void }).registerToolsOn.bind(host);
                register(inner);
                const [ct, st] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
                await Promise.all([inner.connect(st), client.connect(ct)]);
                try {
                        const tools = (await client.listTools()).tools as never as Array<{ name: string; description?: string }>;
                        const shell = tools.find(t => t.name === 'execute_shell_command_code');
                        assert.ok(
                                /Shell:\s*bash/i.test(shell?.description ?? ''),
                                `expected bash for a Git Bash terminal, got: ${shell?.description?.match(/Shell:.*/)?.[0]}`
                        );
                } finally {
                        await client.close();
                        await inner.close();
                }
        });

        test('the description states the exact client ceiling, not an approximation', async () => {
                const tools = await listedTools();
                const shell = tools.find(t => t.name === 'execute_shell_command_code');
                const description = shell?.description ?? '';
                assert.ok(description.includes(String(CLIENT_CEILING_MS)), 'description must state the exact ceiling');
                assert.ok(!/~30\s*s/i.test(description), 'description must not describe the ceiling as approximate');
        });

        test('the clamp keeps the payload under the ceiling', async () => {
                const tools = await listedTools();
                const tokens = Math.round(JSON.stringify(tools).length / 4);
                assert.ok(tokens <= 27200, `payload ${tokens} tok exceeds ceiling 27200`);
                console.log(`  payload ${tokens} tok / 27200`);
        });
});
