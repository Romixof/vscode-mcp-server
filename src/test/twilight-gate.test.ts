import * as assert from 'assert';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServer, ToolConfiguration, resetTwilightForTests, isTwilightUnlocked } from '../server';

const ALL_ON = {
	file: true, edit: true, shell: true, diagnostics: true, symbol: true,
	memory: true, test: true, git: true, documentation: true, database: true,
	productivity: true, security: true, performance: true, refactoring: true,
	frontend: true, workflow: true, advanced: true, skills: true, ocr: true
} as unknown as ToolConfiguration;

interface TwSession {
	client: Client;
	host: MCPServer;
	connect: Promise<unknown>;
}

function startSession(twilightGate: boolean): TwSession {
	const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_ON, undefined, twilightGate);
	host.setFileListingCallback(async () => []);
	const inner = (host as unknown as { buildSessionServer(): McpServer }).buildSessionServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'twilight-test', version: '1.0.0' }, { capabilities: {} });
	return { client, host, connect: Promise.all([inner.connect(serverTransport), client.connect(clientTransport)]) };
}

async function ready(session: TwSession): Promise<{ client: Client; host: MCPServer }> {
	await session.connect;
	return { client: session.client, host: session.host };
}

suite('twilight gate (Mammouth one-tool listing)', () => {
	setup(() => {
		resetTwilightForTests();
		process.env.VSCODE_MCP_TWILIGHT_GATE = '1';
	});

	teardown(() => {
		delete process.env.VSCODE_MCP_TWILIGHT_GATE;
		resetTwilightForTests();
	});

	test('gate armed: tools/list shows exactly one tool, session_bootstrap_code', async () => {
		const { client } = await ready(startSession(true));
		const { tools } = await client.listTools();
		const names = tools.map(t => t.name);
		assert.deepStrictEqual(names, ['session_bootstrap_code'], `gate must list exactly the bootstrap tool, got: ${names.join(', ')}`);
	});

	test('gate off: tools/list shows the whole catalog', async () => {
		const { client } = await ready(startSession(false));
		const { tools } = await client.listTools();
		assert.ok(tools.filter(t => t.name.endsWith('_code')).length >= 88, 'twilightGate=false must leave every tool listed');
	});

	test('the MCP handshake alone does NOT open the gate', async () => {
		await ready(startSession(true));
		assert.strictEqual(isTwilightUnlocked(), false, 'initialized without a bootstrap call must keep the gate closed');
	});

	test('calling session_bootstrap_code opens the gate for every later session', async () => {
		const first = await ready(startSession(true));
		await first.client.callTool({ name: 'session_bootstrap_code', arguments: {} });
		assert.ok(isTwilightUnlocked(), 'the bootstrap call must pass the gate');
		// A brand-new session server in the same process now lists everything.
		const second = await ready(startSession(true));
		const { tools } = await second.client.listTools();
		assert.ok(tools.filter(t => t.name.endsWith('_code')).length >= 88, `after the gate passed the catalog must be listed, got ${tools.length}`);
	});

	test('clientInfo declares the gate: listChanged stays advertised', async () => {
		const { client } = await ready(startSession(true));
		// The server capabilities come back in the initialize result; assert
		// through the SDK client's stored server capabilities.
		const caps = (client as unknown as { getServerCapabilities(): { tools?: { listChanged?: boolean } } }).getServerCapabilities();
		assert.ok(caps.tools?.listChanged, 'tools/listChanged must stay advertised so clients know to re-list');
	});
});
