import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerSessionBootstrapTool } from '../tools/advanced-tools';
import { AGENT_INSTRUCTIONS_VERSION } from '../utils/agent-instructions';

const ARGS = { memory: false, guide: true, skills: false, layout: false };

function newServer(override?: () => string | undefined): McpServer {
        const inner = new McpServer({ name: 'boot', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        registerSessionBootstrapTool(inner, override);
        return inner;
}

async function withServer<T>(server: McpServer, body: (call: (args?: Record<string, unknown>) => Promise<string>) => Promise<T>): Promise<T> {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const call = async (args: Record<string, unknown> = ARGS): Promise<string> => {
                const result = await client.callTool({ name: 'session_bootstrap_code', arguments: args });
                return ((result as { content?: Array<{ text?: string }> }).content ?? [])
                        .map(c => c.text ?? '').join('\n');
        };
        try {
                return await body(call);
        } finally {
                await client.close();
                await server.close();
        }
}

suite('session_bootstrap_code guide delivery', () => {
        test('the first call carries the catalog, the second is a short notice', async () => {
                await withServer(newServer(), async call => {
                        const first = await call();
                        assert.ok(first.includes('FULL TOOL CATALOG'), 'the first call must carry the catalog');
                        assert.ok(first.includes(`[agent guide v${AGENT_INSTRUCTIONS_VERSION}]`), 'the first call must carry the version tag');

                        const second = await call();
                        assert.ok(!second.includes('FULL TOOL CATALOG'), 'the catalog must not be sent twice on one server');
                        assert.ok(
                                second.includes(`v${AGENT_INSTRUCTIONS_VERSION} was already sent`),
                                `the second call must say the guide was already sent: ${second}`
                        );
                        assert.ok(
                                second.includes('get_agent_instructions_code()'),
                                'the notice must name the tool that returns it: ' + second
                        );
                        assert.ok(
                                second.length < first.length / 4,
                                `the second call must be far shorter, got ${second.length} vs ${first.length}`
                        );
                });
        });

        test('a guide whose content changes is delivered again', async () => {
                let override: string | undefined = 'A FIRST GUIDE';
                await withServer(newServer(() => override), async call => {
                        const first = await call();
                        assert.ok(first.includes('A FIRST GUIDE'), 'the first override must be delivered');

                        const second = await call();
                        assert.ok(!second.includes('A FIRST GUIDE'), 'an unchanged override must not repeat');
                        assert.ok(second.includes('was already sent'), `the notice must appear: ${second}`);

                        override = 'A SECOND AND DIFFERENT GUIDE';
                        const third = await call();
                        assert.ok(third.includes('A SECOND AND DIFFERENT GUIDE'), 'a changed guide must be delivered again');
                        assert.ok(
                                third.includes(`[agent guide v${AGENT_INSTRUCTIONS_VERSION}]`),
                                'the re-delivered guide must carry the version tag'
                        );

                        const fourth = await call();
                        assert.ok(!fourth.includes('A SECOND AND DIFFERENT GUIDE'), 'the new override must not repeat either');
                });
        });

        test('a second server does not inherit the first server delivery', async () => {
                const first = await withServer(newServer(), async call => call());
                assert.ok(first.includes('FULL TOOL CATALOG'), 'the first server must carry the catalog');

                const second = await withServer(newServer(), async call => call());
                assert.ok(
                        second.includes('FULL TOOL CATALOG'),
                        'a freshly registered server must carry the catalog, not a notice it never earned'
                );
                assert.ok(
                        !second.includes('was already sent'),
                        `a fresh server must not claim the guide was already sent: ${second.slice(0, 200)}`
                );
        });

        test('guide=false never mentions the guide', async () => {
                await withServer(newServer(), async call => {
                        const text = await call({ memory: false, guide: false, skills: false, layout: false });
                        assert.ok(!/guide/i.test(text), `guide=false must be silent about the guide: ${text}`);
                });
        });
});
