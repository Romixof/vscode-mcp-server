import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPServer, ToolConfiguration } from '../server';

const CLIENT_CEILING_MS = 30000;

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

        test('the default stays under the calling client ceiling', async () => {
                const { timeoutDefault } = await shellToolSchema();
                assert.ok(
                        timeoutDefault < CLIENT_CEILING_MS,
                        `default ${timeoutDefault}ms is not below the ~${CLIENT_CEILING_MS}ms client ceiling, so a timeout returns nothing to the model`
                );
                console.log(`  ${timeoutDefault}ms leaves headroom under the ~${CLIENT_CEILING_MS}ms client ceiling`);
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
