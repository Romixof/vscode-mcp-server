import * as assert from 'assert';
import { AGENT_INSTRUCTIONS_VERSION, resolveAgentInstructions, registerLookupTool, DEFAULT_AGENT_INSTRUCTIONS } from '../utils/agent-instructions';
import { TOOL_HINTS } from '../utils/tool-annotations';
import { CATALOG, compactCatalogIndex, searchCatalog, renderToolCard, catalogSize } from '../utils/tool-catalog';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

suite('tool catalog (RAG source)', () => {
        test('every registered tool has a catalog card, and every card is registered', () => {
                const registered = new Set(Object.keys(TOOL_HINTS));
                const cards = new Set(Object.keys(CATALOG));
                const missingCards = [...registered].filter(n => !cards.has(n));
                const orphanCards = [...cards].filter(n => !TOOL_HINTS[n]);
                assert.deepStrictEqual(missingCards, [], `registered tools without a catalog card: ${missingCards.join(', ')}`);
                assert.deepStrictEqual(orphanCards, [], `catalog cards that match no registered tool: ${orphanCards.join(', ')}`);
        });

        test('every card carries a signature, a brief and keywords', () => {
                const thin = Object.entries(CATALOG).filter(([, m]) => !m.sig.startsWith(m && '' ) && (!m.sig || !m.brief || !m.kw || m.kw.split(' ').length < 2));
                assert.deepStrictEqual(thin.map(([n]) => n), [], 'thin cards (no sig/brief/kw or a one-word keyword bag)');
        });

        test('the compact index is a few hundred tokens, not 30K', () => {
                const tokens = Math.round(compactCatalogIndex().length / 4);
                console.log(`  compact guide body: ~${tokens} tok`);
                assert.ok(tokens <= 1800, `compact index is ${tokens} tok, budget 1800`);
        });

        test('lookup in English finds the right tool first', () => {
                const top = (q: string, n = 3): string[] => searchCatalog(q, n).map(c => c.name);
                assert.ok(top('read a pdf page as image').includes('render_pdf_pages_code'), `pdf read: ${top('read a pdf page as image')}`);
                assert.ok(top('run the tests then tell me coverage')[0] === 'run_tests_code', `tests: ${top('run the tests')}`);
                assert.ok(top('commit my changes to git')[0] === 'commit_changes_code', `commit: ${top('commit my changes')}`);
                assert.ok(top('where is this function defined')[0] === 'get_symbol_definition_code', `definition: ${top('where is this function defined')}`);
                assert.ok(top('search the codebase for this pattern')[0] === 'search_workspace_code', `search: ${top('search the codebase for this pattern')}`);
        });

        test('lookup in French finds the right tool first (diacritic-free)', () => {
                const top = (q: string, n = 3): string[] => searchCatalog(q, n).map(c => c.name);
                assert.ok(top('lire un fichier')[0] === 'read_file_code', `lire: ${top('lire un fichier')}`);
                assert.ok(top('créer un fichier')[0] === 'create_file_code', `créer: ${top('créer un fichier')}`);
                assert.ok(top('exécuter les tests')[0] === 'run_tests_code', `exécuter: ${top('exécuter les tests')}`);
                assert.ok(top('chercher du texte')[0] === 'search_workspace_code', `chercher: ${top('chercher du texte')}`);
        });

        test('lookup returns cards the model can copy verbatim', () => {
                for (const card of searchCatalog('edit a file', 2)) {
                        const line = renderToolCard(card);
                        assert.ok(line.startsWith('['), `card carries the RO/MUT/DST tag: ${line}`);
                        assert.ok(line.includes(card.name), `card names the tool: ${line}`);
                }
        });

        test('the full-guide fallback names the opener and the fallback', () => {
                assert.ok(DEFAULT_AGENT_INSTRUCTIONS.includes('session_bootstrap_code'), 'full guide must name the opener');
                assert.ok(DEFAULT_AGENT_INSTRUCTIONS.includes('get_agent_instructions_code'), 'full guide must name the fallback');
        });
});

suite('lookup_tool_code over MCP', () => {
        async function lookup(query: string): Promise<string> {
                const inner = new McpServer({ name: 'lookup', version: 'test' }, { capabilities: { logging: {}, tools: { listChanged: false } } });
                registerLookupTool(inner);
                const [ct, st] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
                await Promise.all([inner.connect(st), client.connect(ct)]);
                try {
                        const result = await client.callTool({ name: 'lookup_tool_code', arguments: { query } });
                        return ((result as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text ?? '').join('\n');
                } finally {
                        await client.close();
                        await inner.close();
                }
        }

        test('a pdf task returns the pdf cards with their signatures', async () => {
                const text = await lookup('read a scanned pdf page');
                assert.ok(text.includes('ocr_pdf_code'), `result: ${text}`);
                assert.ok(text.includes('render_pdf_pages_code'), `result: ${text}`);
                assert.ok(text.includes('pdfPath'), `signature present: ${text}`);
        });

        test('no match returns a short retry hint, empty output never happens', async () => {
                const text = await lookup('zzzqqq');
                assert.ok(text.includes('No tool matches'), `hint: ${text}`);
                assert.ok(text.length < 600, `hint must be short: ${text}`);
        });
});

suite('compact guide over resolveAgentInstructions', () => {
        test('serves the compact index, not the full catalog, when no override exists', () => {
                const guide = resolveAgentInstructions();
                assert.ok(guide.includes('TOOL INDEX'), 'compact guide must carry the TOOL INDEX header');
                assert.ok(!guide.includes('FULL TOOL CATALOG'), 'compact guide must not resurrect the full catalog');
                assert.ok(guide.length < DEFAULT_AGENT_INSTRUCTIONS.length / 4, `compact guide should be far smaller: ${guide.length} vs ${DEFAULT_AGENT_INSTRUCTIONS.length}`);
        });

        test('carries the version tag and all 100 tool names', () => {
                const guide = resolveAgentInstructions();
                const names = Object.keys(CATALOG).filter(n => !guide.includes(n));
                assert.deepStrictEqual(names, [], `tools missing from the compact index: ${names.join(', ')}`);
                assert.ok(/^\d+$/.test(AGENT_INSTRUCTIONS_VERSION));
        });
});
