import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from 'zod';
import { registerSessionBootstrapTool } from '../tools/advanced-tools';
import { normalizeRelayArgs } from '../utils/relay-args';
import { anchorMatches, validateLineRange } from '../tools/edit-tools';

interface CallResult {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
}

function newServer(): McpServer {
        const server = new McpServer({ name: 'relay-args', version: 'test' }, {
                capabilities: { logging: {}, tools: { listChanged: false } }
        });
        registerSessionBootstrapTool(server);
        // Same parameter names as the real search and replace_lines tools.
        server.tool('search_like_x', 'search', {
                pattern: z.string(), glob: z.string().optional(), maxResults: z.number().optional()
        }, async (a) => ({ content: [{ type: 'text', text: `ARGS:${JSON.stringify(a)}` }] }));
        server.tool('lines_like_x', 'lines', {
                path: z.string(), startLine: z.number(), endLine: z.number(), content: z.string().optional()
        }, async (a) => ({ content: [{ type: 'text', text: `ARGS:${JSON.stringify(a)}` }] }));
        return server;
}

async function call(args: Record<string, unknown>): Promise<CallResult> {
        const server = newServer();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
        await Promise.all([server.connect(st), client.connect(ct)]);
        try {
                return await client.callTool({ name: 'session_bootstrap_code', arguments: args }) as CallResult;
        } finally {
                await client.close();
                await server.close();
        }
}

const text = (r: CallResult): string => (r.content ?? []).map(c => c.text ?? '').join('\n');
const argsOf = (r: CallResult): Record<string, unknown> => JSON.parse((text(r).match(/ARGS:(\{.*?\})(\n|$)/) ?? [])[1] ?? '{}');

suite('relay argument repair (Mammouth session 2026-11-01)', () => {
        test('query and include map onto pattern and glob instead of vanishing', async () => {
                const r = await call({ action: 'call', tool: 'search_like_x', args: { query: 'assistant', include: '**/index.php' } });
                assert.ok(!r.isError, text(r));
                assert.deepStrictEqual(argsOf(r), { pattern: 'assistant', glob: '**/index.php' });
                assert.ok(/include -> glob/.test(text(r)), `the model must learn the real name: ${text(r)}`);
        });

        test('isRegex=false escapes the literal pattern', () => {
                const n = normalizeRelayArgs({ pattern: 'a.b(c)', isRegex: false }, ['pattern', 'glob']);
                assert.strictEqual(n.args.pattern, 'a\\.b\\(c\\)');
                assert.deepStrictEqual(n.unknown, []);
        });

        test('case and underscore variants match the real key', () => {
                const n = normalizeRelayArgs({ StartLine: 3, end_line: 4, Path: 'a' }, ['path', 'startLine', 'endLine']);
                assert.deepStrictEqual(n.args, { path: 'a', startLine: 3, endLine: 4 });
        });

        test('NewText maps onto content', async () => {
                const r = await call({ action: 'call', tool: 'lines_like_x', args: { path: 'a', startLine: 1, endLine: 2, NewText: '' } });
                assert.ok(!r.isError, text(r));
                assert.strictEqual(argsOf(r).content, '');
        });

        test('line numbers sent as firstLine/lastLine become startLine/endLine', () => {
                const n = normalizeRelayArgs({ path: 'a', firstLine: 3217, lastLine: '3270' }, ['path', 'startLine', 'endLine', 'firstLine', 'lastLine']);
                assert.deepStrictEqual(n.args, { path: 'a', startLine: 3217, endLine: 3270 });
        });

        test('OriginalCode/NewCode on edit_file_code map to old_string/new_string', () => {
                const n = normalizeRelayArgs({ path: 'a', OriginalCode: 'x', NewCode: 'y' }, ['path', 'old_string', 'new_string', 'replace_all', 'workspace']);
                assert.deepStrictEqual(n.unknown, []);
                assert.deepStrictEqual(n.args, { path: 'a', old_string: 'x', new_string: 'y' });
        });

        test('old_string/new_string on replace_lines_code map to originalCode/content', () => {
                const n = normalizeRelayArgs({ path: 'a', startLine: 1, endLine: 1, old_string: 'x', new_string: 'y' }, ['path', 'startLine', 'endLine', 'content', 'originalCode', 'firstLine', 'lastLine']);
                assert.deepStrictEqual(n.unknown, []);
                assert.strictEqual(n.args.originalCode, 'x');
                assert.strictEqual(n.args.content, 'y');
        });

        test('a real argument is never overwritten by a synonym', () => {
                const n = normalizeRelayArgs({ pattern: 'real', query: 'guess' }, ['pattern']);
                assert.strictEqual(n.args.pattern, 'real');
                assert.deepStrictEqual(n.unknown, ['query']);
        });

        test('an unknown key is refused loudly with the valid names, and nothing runs', async () => {
                const r = await call({ action: 'call', tool: 'search_like_x', args: { pattern: 'x', bogusFlag: true } });
                assert.ok(r.isError, 'unknown key must be an error');
                assert.ok(/bogusFlag/.test(text(r)) && /pattern, glob, maxResults/.test(text(r)), text(r));
                assert.ok(!/ARGS:/.test(text(r)), 'the tool must not run');
        });
});

suite('bootstrap without action="call"', () => {
        test('tool + args without action relays instead of bootstrapping', async () => {
                const r = await call({ tool: 'search_like_x', args: { pattern: 'x' } });
                assert.ok(!r.isError, text(r));
                assert.ok(text(r).includes('ARGS:'), `the tool must run: ${text(r)}`);
                assert.ok(!text(r).includes('Session bootstrap'), 'no bootstrap header');
        });

        test('tool with action="bootstrap" is an explicit error, not a silent bootstrap', async () => {
                const r = await call({ action: 'bootstrap', tool: 'search_like_x', args: { pattern: 'x' } });
                assert.ok(r.isError, 'must be an error');
                assert.ok(/Nothing ran/.test(text(r)) && /action="call"/.test(text(r)), text(r));
        });

        test('a plain compact bootstrap says it ran no other tool and that edit tools work', async () => {
                const r = await call({ mode: 'compact' });
                assert.ok(!r.isError, text(r));
                assert.ok(/ran no other tool/.test(text(r)) && /edit_file_code/.test(text(r)) && /no limit/.test(text(r)), text(r));
        });
});

suite('replace_lines_code validation', () => {
        const minified = '.aiw-fab{position:fixed;right:22px;bottom:22px;z-index:9500;width:58px;height:58px;border-radius:50%;}';

        test('a line-start anchor validates a long minified line', () => {
                assert.ok(anchorMatches(minified, '.aiw-fab{position:fixed'));
                assert.ok(anchorMatches('    <!-- ASSISTANT IA FLOTTANT (Groq) -->', '<!-- ASSISTANT IA'));
                assert.ok(anchorMatches(minified, '.aiw-fab{position:fixed...'), 'a trailing ellipsis is ignored');
        });

        test('a short anchor cannot vouch for a long line, but a whole short line can', () => {
                assert.ok(!anchorMatches(minified, '.aiw'));
                assert.ok(anchorMatches('}', '}'));
                assert.ok(!anchorMatches(minified, '.aiw-panel{position'));
        });

        test('anchors pass on the right range and fail with the real lines shown', () => {
                const lines = ['<!-- ASSISTANT IA FLOTTANT (Groq) -->', minified, '</script>'];
                validateLineRange(lines, 3216, { firstLine: '<!-- ASSISTANT IA FLOTTANT', lastLine: '</script>' });
                assert.throws(() => validateLineRange(lines, 3216, { firstLine: '<!-- ASSISTANT IA FLOTTANT', lastLine: '</body>' }),
                        (e: Error) => /line 3219 starts with "<\/script>"/.test(e.message) && /Nothing was written/.test(e.message) && /lastLine="<\/script>"/.test(e.message));
        });

        test('no validation is refused, but the error hands over the exact anchors to retry with', () => {
                assert.throws(() => validateLineRange(['<!-- ASSISTANT IA FLOTTANT (Groq) -->', minified, '</script>'], 3216, {}),
                        (e: Error) => /Validation required/.test(e.message)
                                && /firstLine="<!-- ASSISTANT IA FLOTTANT \(Groq\) -->"/.test(e.message)
                                && /lastLine="<\/script>"/.test(e.message));
        });

        test('a blank end line is named as blank and its anchor is ""', () => {
                assert.throws(() => validateLineRange(['/* — Assistant IA flottant (Groq) — */', ''], 1552, { firstLine: '/* — Assistant IA flottant', lastLine: '@media(max-width:480px)' }),
                        (e: Error) => /line 1554 is blank/.test(e.message) && /lastLine=""/.test(e.message));
                validateLineRange(['/* — Assistant IA flottant (Groq) — */', ''], 1552, { firstLine: '/* — Assistant IA flottant', lastLine: '' });
        });

        test('an originalCode mismatch names the first differing line', () => {
                assert.throws(() => validateLineRange(['one', 'two', 'three'], 9, { originalCode: 'one\ntwo\nTHREE' }),
                        (e: Error) => /at line 12/.test(e.message) && /firstLine \+ lastLine/.test(e.message));
                validateLineRange(['one', 'two'], 0, { originalCode: 'one\r\ntwo' });
        });
});
