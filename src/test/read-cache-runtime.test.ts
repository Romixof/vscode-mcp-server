import * as assert from 'assert';
import * as path from 'path';
import { isNoiseEntry, listingEntryLine } from '../tools/file-tools';
import { unchangedReadNotice, fileFingerprint, recentReads, recordRead, repeatSavings, ReadCache } from '../utils/read-cache';
import { runtimeSection, pythonCacheGuard, detectRuntimeFacts } from '../utils/runtime-facts';
import type { Context } from 'mocha';

suite('list listing carries size and date', () => {
        test('noise directories are filtered', () => {
                for (const name of ['__pycache__', 'node_modules', '.git', '.venv', 'dist', '.mypy_cache']) {
                        assert.ok(isNoiseEntry(name), `${name} should be filtered from listings`);
                }
        });

        test('real entries are not filtered', () => {
                for (const name of ['src', 'README.md', 'generate_pdf.py', 'fonts', 'package.json', '__init__.py']) {
                        assert.ok(!isNoiseEntry(name), `${name} must stay visible`);
                }
        });

        test('a file line states size and modification date', () => {
                const line = listingEntryLine({ path: 'a/b.md', type: 'file', size: 2048, modified: 1758000000000 });
                assert.ok(line.includes('a/b.md'), 'must show the path');
                assert.ok(/2\.0\s?KB|\b2048\b/.test(line), `must show the size: ${line}`);
                assert.ok(/\d{2}:\d{2}|\d{4}-\d{2}-\d{2}/.test(line), `must show a date: ${line}`);
        });

        test('a directory line stays compact', () => {
                const line = listingEntryLine({ path: 'src', type: 'directory' });
                assert.ok(line.includes('src'));
                assert.ok(!/KB/.test(line), `a directory has no size: ${line}`);
        });
});

suite('read cache detects unchanged files', () => {
        function cached(chars: number, lines: number, fingerprint = 'fp1'): ReadCache {
                const cache = recentReads();
                cache.set('a.md', { fingerprint, at: new Date('2026-09-25T01:09:00Z'), chars, lines });
                return cache;
        }

        test('a fingerprint is stable for the same stat', () => {
                const a = fileFingerprint({ size: 10, mtime: 5 });
                const b = fileFingerprint({ size: 10, mtime: 5 });
                assert.strictEqual(a, b);
        });

        test('a fingerprint changes when the file changes', () => {
                assert.notStrictEqual(fileFingerprint({ size: 10, mtime: 5 }), fileFingerprint({ size: 10, mtime: 6 }));
                assert.notStrictEqual(fileFingerprint({ size: 10, mtime: 5 }), fileFingerprint({ size: 11, mtime: 5 }));
        });

        test('a full re-read of an unchanged file yields a notice, not a second copy', () => {
                const hit = unchangedReadNotice('a.md', 'fp1', cached(3840, 120), -1, -1);
                assert.ok(hit, 'a full unchanged re-read must be detected');
                assert.ok(/unchanged/i.test(hit), hit);
                assert.ok(/\d{2}:\d{2}/.test(hit), `must state a clock time: ${hit}`);
                assert.ok(hit.includes('3840'), `must state the size already in context: ${hit}`);
                assert.ok(hit.includes('120 lines'), `must state the line count: ${hit}`);
                assert.ok(hit.includes('startLine'), `must point at the ranged-read escape hatch: ${hit}`);
        });

        test('a ranged read is never short-circuited', () => {
                const cache = cached(3840, 120);
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 120, 130), null, 'a line range must still return content');
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, -1, 50), null, 'a partial read must still return content');
        });

        test('a changed file is never short-circuited', () => {
                assert.strictEqual(unchangedReadNotice('a.md', 'fp2', cached(10, 3), -1, -1), null);
        });

        test('a first read is never short-circuited', () => {
                assert.strictEqual(unchangedReadNotice('never-read.md', 'fp1', recentReads(), -1, -1), null);
        });

        test('a whole read asked for as a huge line range is still the whole read', () => {
                const cache = cached(3840, 120);
                for (const endLine of [120, 121, 1000, 100000]) {
                        const hit = unchangedReadNotice('a.md', 'fp1', cache, 1, endLine);
                        assert.ok(hit, `startLine 1 with endLine ${endLine} must not return the file a second time`);
                }
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 1, 119), null, 'a genuinely shorter range still returns content');
        });

        test('a section that was already read is not sent twice', () => {
                const cache = recentReads();
                recordRead(cache, 'a.md', 'fp1', 900, 400, 120, 130);
                const hit = unchangedReadNotice('a.md', 'fp1', cache, 120, 130);
                assert.ok(hit, 'the same section read twice must be refused');
                assert.ok(hit.includes('120 to 130'), `must name the section: ${hit}`);
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 200, 260), null, 'another section still returns content');
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, -1, -1), null, 'a partial read must not claim the whole file is present');
        });

        test('a section read does not poison a later whole read', () => {
                const cache = recentReads();
                recordRead(cache, 'a.md', 'fp1', 900, 400, 120, 130);
                recordRead(cache, 'a.md', 'fp1', 3840, 400, -1, -1);
                const hit = unchangedReadNotice('a.md', 'fp1', cache, 1, 100000);
                assert.ok(hit && hit.includes('3840'), `a later whole read must be caught with its real size: ${hit}`);
        });

        test('a section of a changed file is not short-circuited', () => {
                const cache = recentReads();
                recordRead(cache, 'a.md', 'fp1', 900, 400, 120, 130);
                assert.strictEqual(unchangedReadNotice('a.md', 'fp2', cache, 120, 130), null);
        });

        test('a refused repeat is counted, and a served read is not', () => {
                const cache = recentReads();
                const before = repeatSavings();
                recordRead(cache, 'a.md', 'fp1', 3840, 400, -1, -1);

                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, -1, -1) !== null, true, 'the full re-read must be refused');
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 1, 100000) !== null, true, 'the same read as a range must be refused too');
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 250, 260), null, 'a fresh section must be served');

                const after = repeatSavings();
                assert.strictEqual(after.refused - before.refused, 2, 'exactly the two refusals must be counted');
                assert.strictEqual(after.chars - before.chars, 7680, 'both copies of the file must be counted as not re-sent');
        });
});

suite('runtime facts', function () {
        suiteSetup(async function (this: Context) {
                this.timeout(15000);
                await detectRuntimeFacts();
        });

        test('the runtime probe stays far under the client ceiling', async () => {
                const started = Date.now();
                await detectRuntimeFacts();
                const elapsed = Date.now() - started;
                assert.ok(elapsed < 5000, `runtime probe took ${elapsed}ms; it must not eat the 30s client budget`);
        });

        test('the runtime probe spawns python once and caches', async () => {
                const again = Date.now();
                const first = await detectRuntimeFacts();
                const second = await detectRuntimeFacts();
                const elapsed = Date.now() - again;
                assert.strictEqual(first, second, 'the probe result must be cached, not recomputed per call');
                assert.ok(elapsed < 50, `cached probe took ${elapsed}ms`);
        });

        test('the runtime section names the interpreter and platform', () => {
                const section = runtimeSection({ platform: 'win32', python: '3.11.9' });
                assert.ok(/python/i.test(section), 'must name python');
                assert.ok(/win32/.test(section), 'must name the platform');
        });

        test('the runtime section lists which libraries import', () => {
                const section = runtimeSection({ platform: 'linux', python: '3.12', libs: { reportlab: true, pypdf: false } });
                assert.ok(/reportlab/.test(section), 'must report reportlab');
                assert.ok(/pypdf/.test(section), 'must report pypdf');
                assert.ok(/missing|absent|not installed/i.test(section), 'must mark a missing library');
        });

        test('the cache guard disables bytecode writes for python', () => {
                const guarded = pythonCacheGuard('python generate_pdf.py --md a.md', 'win32');
                assert.ok(guarded, 'a python command must be guarded');
                assert.ok(guarded.includes('PYTHONDONTWRITEBYTECODE=1'), guarded);
                assert.ok(guarded.includes('python generate_pdf.py'), 'the original command must survive');
        });

        test('the cache guard leaves non-python commands alone', () => {
                for (const cmd of ['ls -la', 'grep -r foo .', 'curl https://x', 'pdftoppm -png a.pdf']) {
                        assert.strictEqual(pythonCacheGuard(cmd, 'win32'), null, `${cmd} must not be rewritten`);
                }
        });

        test('the cache guard does not corrupt a heredoc or a pipe', () => {
                const piped = pythonCacheGuard("python -c \"print(1)\" | tee out.txt", 'win32');
                assert.ok(piped === null || piped.startsWith('PYTHONDONTWRITEBYTECODE=1 python'), `bad guard: ${piped}`);
        });
});
