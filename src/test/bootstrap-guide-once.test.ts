import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerSessionBootstrapTool } from '../tools/advanced-tools';
import { AGENT_INSTRUCTIONS_VERSION } from '../utils/agent-instructions';

async function bootstrap(override?: () => string | undefined): Promise<string> {
        const inner = new McpServer({ name: 'boot', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        registerSessionBootstrapTool(inner, override);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([inner.connect(st), client.connect(ct)]);
        try {
                const result = await client.callTool({
                        name: 'session_bootstrap_code',
                        arguments: { memory: false, guide: true, skills: false, layout: false }
                });
                const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
                return content.map(c => c.text ?? '').join('\n');
        } finally {
                await client.close();
                await inner.close();
        }
}

suite('session_bootstrap_code guide delivery', () => {
        test('full guide, then a notice, then full again once the guide changes', async () => {
                const first = await bootstrap();
                assert.ok(first.includes('FULL TOOL CATALOG'), 'the first call must carry the catalog');
                assert.ok(first.includes(`[agent guide v${AGENT_INSTRUCTIONS_VERSION}]`), 'the first call must carry the version tag');

                const second = await bootstrap();
                assert.ok(!second.includes('FULL TOOL CATALOG'), 'the catalog must not be sent twice');
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

                const changed = await bootstrap(() => 'A COMPLETELY DIFFERENT GUIDE');
                assert.ok(changed.includes('A COMPLETELY DIFFERENT GUIDE'), 'a changed guide must be sent again');
                assert.ok(changed.includes(`[agent guide v${AGENT_INSTRUCTIONS_VERSION}]`), 'the changed guide must carry the version tag');

                const unchanged = await bootstrap(() => 'A COMPLETELY DIFFERENT GUIDE');
                assert.ok(!unchanged.includes('A COMPLETELY DIFFERENT GUIDE'), 'the overridden guide must not be sent twice either');
        });

        test('guide=false never mentions the guide', async () => {
                const inner = new McpServer({ name: 'boot', version: 'test' }, {
                        capabilities: { logging: {}, tools: { listChanged: false } }
                });
                registerSessionBootstrapTool(inner);
                const [ct, st] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
                await Promise.all([inner.connect(st), client.connect(ct)]);
                try {
                        const result = await client.callTool({
                                name: 'session_bootstrap_code',
                                arguments: { memory: false, guide: false, skills: false, layout: false }
                        });
                        const text = ((result as { content?: Array<{ text?: string }> }).content ?? [])
                                .map(c => c.text ?? '').join('\n');
                        assert.ok(!/guide/i.test(text), `guide=false must be silent about the guide: ${text}`);
                } finally {
                        await client.close();
                        await inner.close();
                }
        });
});
