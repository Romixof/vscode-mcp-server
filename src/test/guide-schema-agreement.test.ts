import * as assert from 'assert';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../utils/agent-instructions';
import { TOOL_HINTS } from '../utils/tool-annotations';
import { fetchToolList, ListedTool } from './helpers/tool-list';

interface ParamUse {
        tool: string;
        param: string;
        values: string[];
}

function paramsNamedInGuide(): ParamUse[] {
        const uses: ParamUse[] = [];
        const pattern = /([a-z_]+_code)\(([^)]*)\)/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(DEFAULT_AGENT_INSTRUCTIONS)) !== null) {
                const tool = match[1];
                for (const raw of match[2].split(',')) {
                        const [head, tail] = raw.split('=');
                        const param = head.trim();
                        if (param.length === 0 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(param)) {
                                continue;
                        }
                        const values = [...(tail || '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
                        uses.push({ tool, param, values });
                }
        }
        return uses;
}

function enumValuesOf(prop: { enum?: string[]; items?: { enum?: string[] } } | undefined): string[] | undefined {
        return prop && (prop.enum || (prop.items && prop.items.enum));
}

suite('the guide never names a parameter the schema dropped', () => {
        test('every parameter in the catalog exists in that tool schema', async () => {
                const tools: ListedTool[] = await fetchToolList();
                const byName = new Map(tools.map(t => [t.name, t]));
                const uses = paramsNamedInGuide();
                assert.ok(uses.length > 100, `the catalog should name many parameters, parsed ${uses.length}`);

                const problems: string[] = [];
                for (const use of uses) {
                        const tool = byName.get(use.tool);
                        if (!tool) {
                                if (use.tool in TOOL_HINTS) {
                                        problems.push(`${use.tool} is in TOOL_HINTS but not registered`);
                                }
                                continue;
                        }
                        const props = ((tool.inputSchema && tool.inputSchema.properties) || {}) as Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
                        if (!(use.param in props)) {
                                problems.push(`${use.tool}.${use.param} is named in the guide but absent from its schema`);
                                continue;
                        }
                        const allowed = enumValuesOf(props[use.param]);
                        if (allowed) {
                                for (const value of use.values) {
                                        if (!allowed.includes(value)) {
                                                problems.push(`${use.tool}.${use.param}="${value}" is not one of ${allowed.join('|')}`);
                                        }
                                }
                        }
                }
                assert.deepStrictEqual([...new Set(problems)], [], `the guide drifted from the schemas: ${[...new Set(problems)].join('; ')}`);
        });

        test('rule 1 and the tool budget name the same opener', () => {
                const lines = DEFAULT_AGENT_INSTRUCTIONS.split('\n');
                const rule = lines.find(line => line.trim().startsWith('1.'));
                const budget = lines.find(line => line.startsWith('- Open with ONE'));
                assert.ok(rule, 'the workflow must still have a first numbered rule');
                assert.ok(budget, 'the tool budget must still open with one call');

                const openerOf = (line: string): string => line.match(/\b[a-z_]+_code\b/)?.[0] ?? 'undecided';

                assert.strictEqual(
                        openerOf(rule!),
                        openerOf(budget!),
                        `rule 1 and the tool budget disagree on how a session opens:\n  rule 1: ${rule}\n  budget: ${budget}`
                );
                assert.strictEqual(openerOf(rule!), 'session_bootstrap_code', 'the one-call bootstrap must stay the opener');
        });

        test('every registered tool is named in the catalog', async () => {
                const tools: ListedTool[] = await fetchToolList();
                const missing = tools.map(t => t.name).filter(name => !DEFAULT_AGENT_INSTRUCTIONS.includes(name));
                assert.deepStrictEqual(missing, [], `registered tools the guide never names: ${missing.join(', ')}`);
        });
});