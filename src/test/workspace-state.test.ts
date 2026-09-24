import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type StateModule = typeof import('../utils/workspace-state');

interface Entry {
        ts: string;
        session: string;
        tool: string;
        detail: string;
        ok: boolean;
}

const e = (tool: string, ok = true): Entry => ({ ts: '2026-01-01T00:00:00.000Z', session: 's', tool, detail: 'd', ok });

function load(): StateModule {
        const resolved = require.resolve('../utils/workspace-state');
        delete require.cache[resolved];
        return require(resolved) as StateModule;
}

suite('workspace state', () => {
        test('clip returns short text unchanged', () => {
                assert.strictEqual(load().clip('short', 100), 'short');
        });

        test('clip trims over-budget text and reports the drop', () => {
                const out = load().clip('abcdefghij', 4);
                assert.ok(out.startsWith('abcd'));
                assert.ok(out.includes('6 chars trimmed'));
        });

        test('renderState omits blank fields', () => {
                const out = load().renderState({ version: '1.0.0', branch: '   ', status: '' });
                assert.ok(out.includes('Version: 1.0.0'));
                assert.ok(!out.includes('Branch'));
                assert.ok(!out.includes('Status'));
        });

        test('renderState always stamps Updated', () => {
                assert.ok(/Updated: \d{4}-\d{2}-\d{2}T/.test(load().renderState({ version: '1' })));
        });

        test('renderState respects the size cap', () => {
                assert.ok(load().renderState({ inProgress: 'x'.repeat(5000) }).length <= load().STATE_MAX_CHARS + 40);
        });

        test('parseState round-trips every field', () => {
                const m = load();
                const f = { version: '0.20.0', branch: 'master', status: 'green', inProgress: 'editing', nextStep: 'ship' };
                const p = m.parseState(m.renderState(f));
                assert.strictEqual(p.version, '0.20.0');
                assert.strictEqual(p.branch, 'master');
                assert.strictEqual(p.status, 'green');
                assert.strictEqual(p.inProgress, 'editing');
                assert.strictEqual(p.nextStep, 'ship');
        });

        test('parseState tolerates null', () => {
                assert.deepStrictEqual(load().parseState(null), {});
        });

        test('parseState ignores the heading', () => {
                assert.strictEqual(load().parseState('# Workspace state\n\n- Branch: dev\n').branch, 'dev');
        });

        test('appendLogEntry creates the header', () => {
                const out = load().appendLogEntry('', e('t'));
                assert.ok(out.startsWith('# Session log'));
                assert.ok(out.includes('t'));
        });

        test('appendLogEntry appends rather than replaces', () => {
                const m = load();
                const out = m.appendLogEntry(m.appendLogEntry('', e('first_tool')), e('second_tool'));
                assert.ok(out.includes('first_tool'));
                assert.ok(out.includes('second_tool'));
        });

        test('appendLogEntry marks failures', () => {
                assert.ok(load().appendLogEntry('', e('t', false)).includes('(failed)'));
        });

        test('clipLog leaves a short log alone', () => {
                const m = load();
                const short = m.appendLogEntry('', e('t'));
                assert.strictEqual(m.clipLog(short), short);
        });

        test('clipLog drops the oldest past the entry cap', () => {
                const m = load();
                let c = '';
                for (let i = 0; i < m.LOG_KEEP_ENTRIES + 25; i++) {
                        c = m.appendLogEntry(c, e(`tool_${i}`));
                }
                const out = m.clipLog(c);
                assert.ok(out.includes(`tool_${m.LOG_KEEP_ENTRIES + 24}`));
                assert.ok(!out.includes('tool_0`'));
                assert.ok(out.includes('older entries dropped'));
        });

        test('tailLog returns the newest entries', () => {
                const m = load();
                let c = '';
                for (let i = 0; i < 10; i++) {
                        c = m.appendLogEntry(c, e(`tool_${i}`));
                }
                const { text, remaining } = m.tailLog(c, 3);
                assert.ok(text.includes('tool_9'));
                assert.strictEqual(remaining, 7);
        });

        test('tailLog reports nothing pending on a short log', () => {
                const m = load();
                assert.strictEqual(m.tailLog(m.appendLogEntry('', e('t')), 5).remaining, 0);
        });

        test('journal is callable and skips its own state tools', () => {
                const m = load();
                assert.strictEqual(typeof m.recordJournalEvent, 'function');
                m.recordJournalEvent('session_end_code', { summary: 'x' }, true);
                m.recordJournalEvent('workspace_state_code', { path: 'y' }, true);
                m.recordJournalEvent('read_file_code', null, true);
                m.recordJournalEvent('read_file_code', 'string args', true);
                m.recordJournalEvent('read_file_code', { path: 12345 }, true);
        });

        test('the log file stays bounded on disk', () => {
                const m = load();
                let content = '';
                for (let i = 0; i < m.LOG_KEEP_ENTRIES + 40; i++) {
                        content = m.appendLogEntry(content, e(`t${i}`));
                }
                const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-log-')), 'x_LOG.md');
                fs.writeFileSync(tmp, m.clipLog(content), 'utf-8');
                assert.ok(fs.statSync(tmp).size <= m.LOG_MAX_CHARS + 400);
        });
});
