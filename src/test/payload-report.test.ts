import * as assert from 'assert';
import { fetchToolList, ListedTool } from './helpers/tool-list';

interface SizeRow {
        name: string;
        total: number;
        description: number;
        paramDesc: number;
        structure: number;
        shell: number;
        params: number;
}

function measure(tools: ListedTool[]): SizeRow[] {
        return tools.map(t => {
                const schema = t.inputSchema || {};
                const props = schema.properties || {};
                const keys = Object.keys(props);
                const paramDesc = keys.reduce((a, k) => a + ((props[k].description || '').length), 0);
                const schemaChars = JSON.stringify(schema).length;
                const description = (t.description || '').length;
                const shell = schemaChars - keys.reduce((a, k) => a + JSON.stringify(props[k]).length, 0);
                return {
                        name: t.name,
                        total: JSON.stringify(t).length,
                        description,
                        paramDesc,
                        structure: schemaChars - paramDesc,
                        shell,
                        params: keys.length
                };
        });
}

function share(value: number, total: number): string {
        return `${(100 * value / total).toFixed(1)}%`;
}

suite('tools/list payload report', () => {
        test('the composition of the payload, measured not estimated', async () => {
                const tools = await fetchToolList();
                const rows = measure(tools);
                const total = rows.reduce((a, r) => a + r.total, 0);
                const sum = (pick: (r: SizeRow) => number): number => rows.reduce((a, r) => a + pick(r), 0);

                const description = sum(r => r.description);
                const paramDesc = sum(r => r.paramDesc);
                const structure = sum(r => r.structure);
                const shell = sum(r => r.shell);
                const params = sum(r => r.params);
                const names = total - description - paramDesc - structure;

                console.log('');
                console.log('=== tools/list payload report ===');
                console.log(`  total                ${total} chars, ${Math.round(total / 4)} tok, ${tools.length} tools`);
                console.log(`  tool descriptions    ${description} ${share(description, total)}`);
                console.log(`  parameter text       ${paramDesc} ${share(paramDesc, total)}`);
                console.log(`  schema structure     ${structure} ${share(structure, total)}`);
                console.log(`    per-tool shell     ${shell} ${share(shell, total)} (${Math.round(shell / tools.length)} chars x ${tools.length} tools, written by zod-to-json-schema)`);
                console.log(`    marginal params    ${structure - shell} ${share(structure - shell, total)} (${Math.round((structure - shell) / params)} chars x ${params} params)`);
                console.log(`  names + annotations  ${names} ${share(names, total)}`);

                console.log('  --- heaviest tools ---');
                rows.slice().sort((a, b) => b.total - a.total).slice(0, 12)
                        .forEach(r => console.log(`    ${r.name.padEnd(36)} ${String(r.total).padStart(6)}  desc ${String(r.description).padStart(5)}  params ${r.params}`));

                const freq = new Map<string, number>();
                for (const t of tools) {
                        const props = (t.inputSchema && t.inputSchema.properties) || {};
                        for (const k of Object.keys(props)) freq.set(k, (freq.get(k) || 0) + 1);
                }
                const paramText = new Map<string, number>();
                for (const t of tools) {
                        const props = (t.inputSchema && t.inputSchema.properties) || {};
                        for (const [k, v] of Object.entries(props)) paramText.set(k, (paramText.get(k) || 0) + (v.description || '').length);
                }
                console.log('  --- parameter descriptions, largest first ---');
                [...paramText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                        .forEach(([k, v]) => console.log(`    ${k.padEnd(26)} ${String(v).padStart(6)} chars across ${freq.get(k)} tools`));

                let unique = 0;
                for (const [k, v] of freq.entries()) {
                        if (v === 1) {
                                unique++;
                        }
                }
                console.log(`  --- ${unique} of ${params} parameters exist on a single tool only ---`);
                console.log(`payload-report ${JSON.stringify({ total, tok: Math.round(total / 4), tools: tools.length, description, paramDesc, structure, shell, names, params, uniqueParams: unique })}`);
                console.log('');

                assert.ok(tools.length > 0, 'the report must have listed tools, otherwise it silently measures nothing');
                assert.strictEqual(description + paramDesc + structure + names, total, 'the buckets must account for the whole payload exactly once');
                assert.ok(names < total * 0.25, `names + annotations are ${names}, which is too large to be only wrapping`);
        });
});
