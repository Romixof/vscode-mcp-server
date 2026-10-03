import * as assert from 'assert';
import { fetchToolList } from './helpers/tool-list';
import { WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

const EXPECTED_TOOL_COUNT = 91;
const MAX_TOKENS_PER_TOOL = 950;
const P95_TOKENS_PER_TOOL = 480;
const PAYLOAD_CEILING = 26600;
const WORKSPACE_DESC_MAX_CHARS = 90;
const REPEATED_WORKSPACE_DESC_MAX_CHARS = 48;
const MAMMOTH_PER_TOOL_CAP = 32768;

suite('tools/list payload budget', () => {
        test('the tool count is what this budget was sized for', async () => {
                const tools = await fetchToolList();
                assert.strictEqual(tools.length, EXPECTED_TOOL_COUNT, `tool count changed; re-size the payload budget deliberately`);
        });

        test('no single tool carries a runaway description', async () => {
                const tools = await fetchToolList();
                const worst = tools
                        .map(t => ({ name: t.name, tok: Math.round(JSON.stringify(t).length / 4) }))
                        .sort((a, b) => b.tok - a.tok)[0];
                console.log(`  largest tool: ${worst.name} ~${worst.tok} tok`);
                assert.ok(worst.tok <= MAX_TOKENS_PER_TOOL, `${worst.name} is ${worst.tok} tok, cap ${MAX_TOKENS_PER_TOOL}`);
        });

        test('the expensive tail does not creep up', async () => {
                const tools = await fetchToolList();
                const costs = tools.map(t => Math.round(JSON.stringify(t).length / 4)).sort((a, b) => b - a);
                const p95 = costs[Math.floor(costs.length * 0.05)];
                console.log(`  p95 ~${p95} tok/tool`);
                assert.ok(p95 <= P95_TOKENS_PER_TOOL, `p95 is ${p95} tok, budget ${P95_TOKENS_PER_TOOL}`);
        });

        test('the total payload stays under the ceiling', async () => {
                const tools = await fetchToolList();
                const tokens = Math.round(JSON.stringify(tools).length / 4);
                console.log(`  payload: ${tokens} tok of ${PAYLOAD_CEILING}`);
                assert.ok(tokens <= PAYLOAD_CEILING, `payload ${tokens} tok exceeds ceiling ${PAYLOAD_CEILING}`);
        });

        test('the repeated workspace parameter description stays short', async () => {
                const tools = await fetchToolList();
                const withWorkspace = tools.filter(t => t.inputSchema.properties?.workspace?.description);
                const repeated = withWorkspace.filter(t => t.inputSchema.properties?.workspace?.description === WORKSPACE_PARAM_DESCRIPTION);
                console.log(`  workspace: ${WORKSPACE_PARAM_DESCRIPTION.length} chars x ${repeated.length} tools ~${Math.round(WORKSPACE_PARAM_DESCRIPTION.length * repeated.length / 4)} tok`);
                assert.ok(repeated.length > 50, `expected the shared description on most tools, found ${repeated.length} of ${withWorkspace.length}`);
                assert.ok(WORKSPACE_PARAM_DESCRIPTION.length <= REPEATED_WORKSPACE_DESC_MAX_CHARS, `the shared workspace description is ${WORKSPACE_PARAM_DESCRIPTION.length} chars, budget ${REPEATED_WORKSPACE_DESC_MAX_CHARS}`);
        });

        test('no workspace description teaches what the agent guide already teaches', async () => {
                const tools = await fetchToolList();
                const over = tools
                        .filter(t => (t.inputSchema.properties?.workspace?.description?.length ?? 0) > WORKSPACE_DESC_MAX_CHARS)
                        .map(t => `${t.name} (${t.inputSchema.properties?.workspace?.description?.length})`);
                assert.deepStrictEqual(over, [], `a per-tool workspace description may not restate the guide: ${over.join(', ')}`);
        });

        test('no single tool exceeds the per-tool schema cap', async () => {
                const tools = await fetchToolList();
                for (const t of tools) {
                        const size = JSON.stringify(t).length;
                        assert.ok(size < MAMMOTH_PER_TOOL_CAP, `${t.name} is ${size} chars, cap ${MAMMOTH_PER_TOOL_CAP}`);
                }
        });
});
