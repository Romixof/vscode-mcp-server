import * as assert from 'assert';
import { z } from 'zod';
import { objectFromShape } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { fetchToolList } from './helpers/tool-list';
import { schemaKeys } from '../utils/relay-args';

suite('zod 4 upgrade keeps the tool contract', () => {
        test('the relay reads argument names from SDK-built schemas', () => {
                const schema = objectFromShape({ path: z.string(), glob: z.string().optional() });
                assert.deepStrictEqual(schemaKeys(schema), ['path', 'glob']);
                assert.deepStrictEqual(schemaKeys(z.object({ a: z.number() })), ['a']);
                assert.strictEqual(schemaKeys(z.string()), undefined);
        });

        test('tools/list keeps the zod 3 schema shape', async () => {
                const tools = await fetchToolList();
                const problems: string[] = [];
                const walk = (node: unknown, where: string): void => {
                        if (!node || typeof node !== 'object') {
                                return;
                        }
                        const n = node as Record<string, unknown>;
                        if ('propertyNames' in n) {
                                problems.push(`${where}: propertyNames`);
                        }
                        if (Math.abs(Number(n.minimum)) === Number.MAX_SAFE_INTEGER || Math.abs(Number(n.maximum)) === Number.MAX_SAFE_INTEGER) {
                                problems.push(`${where}: safe-integer bound`);
                        }
                        if (n.type === 'object' && n.properties && Object.keys(n.properties).length > 0 && n.additionalProperties !== false) {
                                problems.push(`${where}: additionalProperties not false`);
                        }
                        for (const [k, v] of Object.entries(n)) {
                                walk(v, `${where}.${k}`);
                        }
                };
                for (const tool of tools) {
                        walk(tool.inputSchema, tool.name);
                }
                assert.deepStrictEqual(problems, []);
        });

        // 0.20.45 listed this schema with zod 4's key order and Mammouth stopped
        // sending "tool" on relay calls. Pin the exact bytes clients received
        // through 0.20.44.
        test('session_bootstrap_code is listed byte-for-byte as before zod 4', async () => {
                const tools = await fetchToolList();
                const bootstrap = tools.find(t => t.name === 'session_bootstrap_code');
                assert.ok(bootstrap, 'session_bootstrap_code is listed');
                const expected = '{"type":"object","properties":{"action":{"type":"string","enum":["bootstrap","call"],"description":"bootstrap = default; call = RELAY: run \\"tool\\" with \\"args\\" even though it is not in your client list."},"tool":{"type":"string","description":"action=\\"call\\" only: the tool to run"},"args":{"type":"object","additionalProperties":{},"description":"action=\\"call\\" only: the tool arguments"},"sections":{"type":"array","items":{"type":"string","enum":["memory","guide","skills","layout"]},"description":"Parts to return; omit for all four."},"mode":{"type":"string","enum":["full","compact"],"default":"compact","description":"compact = state only (default); full = the rest, when needed"},"subfolder":{"type":"string","description":"Topic subfolder: memory/state/log under <subfolder>/.mammouth/."},"workspace":{"type":"string","description":"Workspace root: name or 1-based index."}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}';
                assert.strictEqual(JSON.stringify(bootstrap.inputSchema), expected);
        });

        test('every listed keyword keeps the zod 3 order (type first, description last)', async () => {
                const tools = await fetchToolList();
                const late = ['default', 'description', '$schema'];
                const bad: string[] = [];
                const walk = (node: unknown, where: string): void => {
                        if (!node || typeof node !== 'object' || Array.isArray(node)) {
                                return;
                        }
                        const keys = Object.keys(node);
                        if ('type' in node && keys[0] !== 'type') {
                                bad.push(`${where}: ${keys.join(',')}`);
                        }
                        const firstLate = keys.findIndex(k => late.includes(k));
                        if (firstLate !== -1 && keys.slice(firstLate).some(k => !late.includes(k))) {
                                bad.push(`${where}: ${keys.join(',')}`);
                        }
                        const n = node as Record<string, unknown>;
                        for (const [k, v] of Object.entries(n)) {
                                if (k === 'properties' && v && typeof v === 'object') {
                                        for (const [p, s] of Object.entries(v)) {
                                                walk(s, `${where}.${p}`);
                                        }
                                } else {
                                        walk(v, `${where}.${k}`);
                                }
                        }
                };
                for (const tool of tools) {
                        walk(tool.inputSchema, tool.name);
                }
                assert.deepStrictEqual(bad, []);
        });
});
