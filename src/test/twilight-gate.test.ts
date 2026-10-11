import * as assert from 'assert';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServer, ToolConfiguration, resetTwilightForTests, isTwilightUnlocked, setTwilightConfigSource } from '../server';
import { runWithScopes } from '../auth/toolgate';
import { ALL_SCOPES } from '../auth/scopes';

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

function startSession(twilightGate: boolean, applyGateArg = true, twilightStrict?: boolean): TwSession {
	const gateArg = applyGateArg ? twilightGate : undefined;
	const host = new MCPServer(3400, '127.0.0.1', undefined, ALL_ON, undefined, gateArg, twilightStrict);
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

function simulateVsCodeConfig(values: Record<string, unknown>): void {
	const store = new Map(Object.entries(values));
	setTwilightConfigSource({
		get: <T>(section: string, key: string, defaultValue?: T): T =>
			((store.has(key) ? (store.get(key) as T) : defaultValue!) as T)
	});
}

suite('twilight gate (Mammouth one-tool listing)', () => {
	setup(() => {
		resetTwilightForTests();
		process.env.VSCODE_MCP_TWILIGHT_GATE = '1';
		simulateVsCodeConfig({ 'twilightGate': true });
	});

	teardown(() => {
		delete process.env.VSCODE_MCP_TWILIGHT_GATE;
		resetTwilightForTests();
	});
	// resetTwilightForTests also clears the VS Code config source

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

	test('the setting vscode-mcp-server.twilightGate also arms the gate', async () => {
		simulateVsCodeConfig({ 'twilightGate': true });
		const first = await ready(startSession(true, false));
		const { tools } = await first.client.listTools();
		assert.deepStrictEqual(tools.map(t => t.name), ['session_bootstrap_code'], 'setting must arm the gate even without the env var');
		await first.client.callTool({ name: 'session_bootstrap_code', arguments: {} });
		assert.ok(isTwilightUnlocked(), 'the bootstrap call still passes the gate');
		simulateVsCodeConfig({});
	});

	test('env=0 wins over the setting (explicit opt-out)', async () => {
		simulateVsCodeConfig({ 'twilightGate': true });
		process.env.VSCODE_MCP_TWILIGHT_GATE = '0';
		const { client } = await ready(startSession(true, false));
		const { tools } = await client.listTools();
		assert.ok(tools.filter(t => t.name.endsWith('_code')).length >= 88, 'env=0 must disable the gate even with the setting on');
		simulateVsCodeConfig({});
	});

	test('strict mode: the list stays at one tool even after the bootstrap call', async () => {
		simulateVsCodeConfig({});
		const first = await ready(startSession(true, true, true));
		let { tools } = await first.client.listTools();
		assert.deepStrictEqual(tools.map(t => t.name), ['session_bootstrap_code'], 'strict mode starts at the bootstrap tool too');
		// The call that would unlock in loose mode does not grow the list here.
		await first.client.callTool({ name: 'session_bootstrap_code', arguments: {} });
		({ tools } = await first.client.listTools());
		assert.deepStrictEqual(tools.map(t => t.name), ['session_bootstrap_code'], 'strict mode must keep the list at one tool after the gate passes');
		// Fresh session server (new POST): the strict list stays at one.
		const second = await ready(startSession(true, true, true));
		({ tools } = await second.client.listTools());
		assert.deepStrictEqual(tools.map(t => t.name), ['session_bootstrap_code'], 'a re-list (popup re-open) must never see the catalog in strict mode');
	});

	test('strict mode: a non-listed tool stays callable by name', async () => {
		const { client } = await ready(startSession(true, true, true));
		const { tools } = await client.listTools();
		assert.deepStrictEqual(tools.map(t => t.name), ['session_bootstrap_code']);
		// get_agent_instructions_code is [RO], exists in the registry, was never
		// listed and needs no open workspace. The HTTP path grants its clients
		// scopes through runWithScopes; the test client does the same thing the
		// /mcp endpoint does for an api-key call.
		const result = await runWithScopes(ALL_SCOPES, 'twilight-test', () =>
			client.callTool({ name: 'get_agent_instructions_code', arguments: {} })) as { content?: Array<{ text?: string }>; isError?: boolean };
		assert.ok(!result.isError, `the unlisted tool call must not refuse: ${JSON.stringify(result).slice(0, 300)}`);
		assert.ok((result.content ?? []).length > 0 && (result.content?.[0]?.text ?? '').includes('FULL TOOL CATALOG'), 'the call must return the real agent guide');
	});

	test('clientInfo declares the gate: listChanged stays advertised', async () => {
		const { client } = await ready(startSession(true));
		// The server capabilities come back in the initialize result; assert
		// through the SDK client's stored server capabilities.
		const caps = (client as unknown as { getServerCapabilities(): { tools?: { listChanged?: boolean } } }).getServerCapabilities();
		assert.ok(caps.tools?.listChanged, 'tools/listChanged must stay advertised so clients know to re-list');
	});
});
