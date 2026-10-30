import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from 'zod';
import { registerSessionBootstrapTool } from '../tools/advanced-tools';

interface CallResult {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
}

function newServer(extra?: (server: McpServer) => void): McpServer {
        const inner = new McpServer({ name: 'relay', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        registerSessionBootstrapTool(inner);
        if (extra) { extra(inner); }
        return inner;
}

async function call(name: string, args: Record<string, unknown>, server: McpServer): Promise<CallResult> {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([server.connect(st), client.connect(ct)]);
        try {
                return await client.callTool({ name, arguments: args }) as CallResult;
        } finally {
                await client.close();
                await server.close();
        }
}

function text(result: CallResult): string {
        return (result.content ?? []).map(c => c.text ?? '').join('\n');
}

suite('session_bootstrap_code relay (action="call")', () => {
        test('runs the named tool with the given args and returns its result', async () => {
                const server = newServer(s => {
                        s.tool('echo_tool_x', 'echoes its input', { message: z.string() },
                                async ({ message }) => ({ content: [{ type: 'text', text: `ECHO:${message}` }] }));
                });
                const result = await call('session_bootstrap_code', {
                        action: 'call', tool: 'echo_tool_x', args: { message: 'hello' }
                }, server);
                assert.ok(!result.isError, `relay must not fail: ${text(result)}`);
                assert.ok(text(result).includes('ECHO:hello'), `relay must return the target result: ${text(result)}`);
        });

        test('an unknown tool is an isError result that points at lookup_tool_code', async () => {
                const server = newServer();
                const result = await call('session_bootstrap_code', {
                        action: 'call', tool: 'no_such_tool_code', args: {}
                }, server);
                assert.ok(result.isError, 'unknown tool must come back as an error, not a throw');
                assert.ok(text(result).includes('lookup_tool_code'), `error must teach the escape hatch: ${text(result)}`);
        });

        test('missing tool name is an isError result with the invocation shape', async () => {
                const server = newServer();
                const result = await call('session_bootstrap_code', { action: 'call' }, server);
                assert.ok(result.isError, 'missing tool must come back as an error');
                assert.ok(/tool="<name>"/.test(text(result)), `error must show the shape: ${text(result)}`);
        });

        test('relaying session_bootstrap_code through itself is refused', async () => {
                const server = newServer();
                const result = await call('session_bootstrap_code', {
                        action: 'call', tool: 'session_bootstrap_code', args: {}
                }, server);
                assert.ok(result.isError, 'self-relay must be refused');
                assert.ok(/already inside it|Do not relay/i.test(text(result)), `guard must explain why: ${text(result)}`);
        });

        test('a target that throws becomes an isError result the model can read', async () => {
                const server = newServer(s => {
                        s.tool('boom_tool_x', 'always fails', {},
                                async () => { throw new Error('intended failure'); });
                });
                const result = await call('session_bootstrap_code', {
                        action: 'call', tool: 'boom_tool_x', args: {}
                }, server);
                assert.ok(result.isError, 'target failure must be an error result, not a protocol error');
                assert.ok(text(result).includes('intended failure'), `the cause must be visible: ${text(result)}`);
        });

        test('relay mode ignores sections and mode: no bootstrap header leaks into the result', async () => {
                const server = newServer(s => {
                        s.tool('echo_tool_x', 'echoes its input', { message: z.string() },
                                async ({ message }) => ({ content: [{ type: 'text', text: `ECHO:${message}` }] }));
                });
                const result = await call('session_bootstrap_code', {
                        action: 'call', tool: 'echo_tool_x', args: { message: 'pure' },
                        sections: ['guide'], mode: 'compact'
                }, server);
                assert.ok(!result.isError, `relay must not fail: ${text(result)}`);
                assert.ok(!text(result).includes('🚀 Session bootstrap'), `bootstrap output leaked into a relay result: ${text(result)}`);
                assert.ok(text(result).includes('ECHO:pure'), `the target result must be returned untouched: ${text(result)}`);
        });

        test('bootstrap mode is unaffected: sections and guide still work', async () => {
                const server = newServer();
                const result = await call('session_bootstrap_code', { sections: ['guide'] }, server);
                assert.ok(!result.isError, `plain bootstrap must still work: ${text(result)}`);
                assert.ok(text(result).includes('TOOL INDEX'), 'plain bootstrap still serves the guide');
        });

        test('compact re-anchor no longer tells the model to re-call bootstrap (anti-loop)', async () => {
                const server = newServer();
                const result = await call('session_bootstrap_code', { mode: 'compact' }, server);
                const out = text(result);
                assert.ok(!/call session_bootstrap_code\(\) with no arguments/.test(out),
                        `compact still advertises the full re-anchor that caused ~20 loops: ${out}`);
                assert.ok(/Do NOT call session_bootstrap_code again/i.test(out),
                        `compact must warn against re-calling: ${out}`);
                assert.ok(/action="call"/.test(out), `compact must teach the relay: ${out}`);
        });
});