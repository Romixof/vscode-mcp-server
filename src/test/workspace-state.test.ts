import * as assert from 'assert';

type StateModule = typeof import('../utils/workspace-state');

function loadFresh(): StateModule {
        const resolved = require.resolve('../utils/workspace-state');
        delete require.cache[resolved];
        return require(resolved) as StateModule;
}

function logEntry(overrides: Partial<{ ts: string; session: string; tool: string; detail: string; ok: boolean }> = {}) {
        return {
                ts: overrides.ts ?? '2026-09-23T10:00:00.000Z',
                session: overrides.session ?? 's1',
                tool: overrides.tool ?? 'read_file_code',
                detail: overrides.detail ?? 'src/a.ts',
                ok: overrides.ok ?? true
        };
}

describe('workspace state', () => {
        describe('clip', () => {
                it('returns text unchanged when it fits the budget', () => {
                        assert.strictEqual(loadFresh().clip('short', 100), 'short');
                });

                it('trims and reports the dropped character count when over budget', () => {
                        const out = loadFresh().clip('abcdefghij', 4);
                        assert.ok(out.startsWith('abcd'));
                        assert.ok(out.includes('6 chars trimmed'));
                });
        });

        describe('renderState', () => {
                it('omits fields that are empty or whitespace', () => {
                        const out = loadFresh().renderState({ version: '0.19.18', branch: '   ', status: '' });
                        assert.ok(out.includes('Version: 0.19.18'));
                        assert.ok(!out.includes('Branch'));
                        assert.ok(!out.includes('Status'));
                });

                it('always stamps an updated timestamp', () => {
                        const out = loadFresh().renderState({ version: '1' });
                        assert.ok(/Updated: \d{4}-\d{2}-\d{2}T/.test(out));
                });

                it('keeps the rendered state inside the size cap', () => {
                        const out = loadFresh().renderState({ inProgress: 'x'.repeat(5000) });
                        assert.ok(out.length <= loadFresh().STATE_MAX_CHARS + 40);
                });
        });

        describe('parseState', () => {
                it('round-trips every field through render and parse', () => {
                        const m = loadFresh();
                        const fields = { version: '0.19.18', branch: 'master', status: 'green', inProgress: 'editing x', nextStep: 'commit' };
                        const parsed = m.parseState(m.renderState(fields));
                        assert.strictEqual(parsed.version, '0.19.18');
                        assert.strictEqual(parsed.branch, 'master');
                        assert.strictEqual(parsed.status, 'green');
                        assert.strictEqual(parsed.inProgress, 'editing x');
                        assert.strictEqual(parsed.nextStep, 'commit');
                });

                it('returns an empty object for absent content', () => {
                        assert.deepStrictEqual(loadFresh().parseState(null), {});
                });

                it('ignores the markdown heading line', () => {
                        const parsed = loadFresh().parseState('# Workspace state\n\n- Branch: dev\n');
                        assert.strictEqual(parsed.branch, 'dev');
                });
        });

        describe('appendLogEntry', () => {
                it('creates the log header when the file is empty', () => {
                        const out = loadFresh().appendLogEntry('', logEntry());
                        assert.ok(out.startsWith('# Session log'));
                        assert.ok(out.includes('read_file_code'));
                });

                it('appends after existing entries rather than replacing them', () => {
                        const m = loadFresh();
                        const first = m.appendLogEntry('', logEntry({ tool: 'first_tool' }));
                        const second = m.appendLogEntry(first, logEntry({ tool: 'second_tool' }));
                        assert.ok(second.includes('first_tool'));
                        assert.ok(second.includes('second_tool'));
                });

                it('marks a failed entry', () => {
                        const out = loadFresh().appendLogEntry('', logEntry({ ok: false }));
                        assert.ok(out.includes('(failed)'));
                });
        });

        describe('clipLog', () => {
                it('leaves a short log untouched', () => {
                        const m = loadFresh();
                        const short = m.appendLogEntry('', logEntry());
                        assert.strictEqual(m.clipLog(short), short);
                });

                it('drops the oldest entries when the log exceeds the budget', () => {
                        const m = loadFresh();
                        let content = '';
                        for (let i = 0; i < m.LOG_KEEP_ENTRIES + 25; i++) {
                                content = m.appendLogEntry(content, logEntry({ tool: `tool_${i}` }));
                        }
                        const out = m.clipLog(content);
                        assert.ok(out.includes(`tool_${m.LOG_KEEP_ENTRIES + 24}`));
                        assert.ok(!out.includes('tool_0`'));
                        assert.ok(out.includes('older entries dropped'));
                });
        });

        describe('tailLog', () => {
                it('returns the most recent entries', () => {
                        const m = loadFresh();
                        let content = '';
                        for (let i = 0; i < 10; i++) {
                                content = m.appendLogEntry(content, logEntry({ tool: `tool_${i}` }));
                        }
                        const { text, remaining } = m.tailLog(content, 3);
                        assert.ok(text.includes('tool_9'));
                        assert.ok(!text.includes('tool_0`'));
                        assert.strictEqual(remaining, 7);
                });

                it('reports no remaining entries when the log is short', () => {
                        const m = loadFresh();
                        const { remaining, text } = m.tailLog(m.appendLogEntry('', logEntry()), 5);
                        assert.strictEqual(remaining, 0);
                        assert.ok(!text.includes('earlier entries'));
                });
        });
});
