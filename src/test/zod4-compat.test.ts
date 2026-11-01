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
});
