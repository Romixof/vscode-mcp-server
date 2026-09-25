import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';
import { CLIENT_CEILING_MS, CLIENT_BUDGET_MS, RESPONSE_RESERVE_MS } from '../tools/shell-tools';

const ALL_GROUPS_ON = {
        file: true, edit: true, shell: true, diagnostics: true, symbol: true,
        memory: true, test: true, git: true, documentation: true, database: true,
        productivity: true, security: true, performance: true, refactoring: true,
        frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

async function shellToolSchema(): Promise<{ description: string; timeoutDefault: number }> {
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
                const tools = (await client.listTools()).tools;
                const shell = tools.find(t => t.name === 'execute_shell_command_code');
                assert.ok(shell, 'execute_shell_command_code not registered');
                const props = (shell.inputSchema as { properties?: Record<string, { default?: number }> }).properties ?? {};
                return { description: shell.description ?? '', timeoutDefault: props.timeout?.default ?? -1 };
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('shell timeout', () => {
        test('the schema default matches the handler default', async () => {
                const { timeoutDefault } = await shellToolSchema();
                const { SHELL_TIMEOUT_MS } = require('../tools/shell-tools');
                assert.ok(timeoutDefault > 0, 'timeout has no default in the schema');
                assert.strictEqual(timeoutDefault, SHELL_TIMEOUT_MS, `schema says ${timeoutDefault}, constant is ${SHELL_TIMEOUT_MS}`);
                console.log(`  schema default and constant agree at ${SHELL_TIMEOUT_MS}ms`);
        });

        test('the budget is strictly under the measured client ceiling', async () => {
                const { timeoutDefault } = await shellToolSchema();
                assert.strictEqual(
                        CLIENT_CEILING_MS,
                        30000,
                        `client ceiling drifted to ${CLIENT_CEILING_MS}; the measured value is 30000 (client logged 29999ms)`
                );
                assert.ok(
                        CLIENT_BUDGET_MS < CLIENT_CEILING_MS,
                        `budget ${CLIENT_BUDGET_MS}ms must leave response headroom under the ${CLIENT_CEILING_MS}ms ceiling`
                );
                assert.strictEqual(
                        CLIENT_BUDGET_MS + RESPONSE_RESERVE_MS,
                        CLIENT_CEILING_MS,
                        'reserve and budget must add back up to the measured ceiling'
                );
                assert.ok(
                        RESPONSE_RESERVE_MS > 0,
                        'a zero reserve would let the server race the client to the wire'
                );
                assert.ok(
                        CLIENT_BUDGET_MS <= timeoutDefault + 5000,
                        `budget ${CLIENT_BUDGET_MS}ms and default ${timeoutDefault}ms have drifted apart`
                );
                console.log(`  measured ceiling ${CLIENT_CEILING_MS}ms = budget ${CLIENT_BUDGET_MS}ms + ${RESPONSE_RESERVE_MS}ms reserve`);
        });

        test('a budget one millisecond under the ceiling is still rejected', () => {
                const fatalBudget = 29999;
                assert.ok(
                        fatalBudget + RESPONSE_RESERVE_MS > CLIENT_CEILING_MS,
                        'a 29999ms budget is fatal in production and must not satisfy the budget invariant'
                );
        });

        test('the default is long enough for a real command', async () => {
                const { timeoutDefault } = await shellToolSchema();
                assert.ok(timeoutDefault >= 20000, `default ${timeoutDefault}ms is too short for installs or builds`);
        });

        test('the description tells the model about long-running work', async () => {
                const { description } = await shellToolSchema();
                assert.ok(/background_task_code/.test(description), 'description does not point at background_task_code');
                assert.ok(/exit code 124/.test(description), 'description does not explain the 124 recovery path');
        });
});
