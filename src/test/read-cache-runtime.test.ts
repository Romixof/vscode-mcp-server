import * as assert from 'assert';
import * as path from 'path';
import { isNoiseEntry, listingEntryLine } from '../tools/file-tools';
import { unchangedReadNotice, fileFingerprint, recentReads } from '../utils/read-cache';
import { runtimeSection, pythonCacheGuard } from '../utils/runtime-facts';

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
                const cache = recentReads();
                cache.set('a.md', { fingerprint: 'fp1', at: new Date('2026-09-25T01:09:00Z'), chars: 3840 });
                const hit = unchangedReadNotice('a.md', 'fp1', cache, -1, -1);
                assert.ok(hit, 'a full unchanged re-read must be detected');
                assert.ok(/unchanged/i.test(hit), hit);
                assert.ok(/\d{2}:\d{2}/.test(hit), `must state a clock time: ${hit}`);
                assert.ok(hit.includes('3840'), `must state the size already in context: ${hit}`);
                assert.ok(hit.includes('startLine'), `must point at the ranged-read escape hatch: ${hit}`);
        });

        test('a ranged read is never short-circuited', () => {
                const cache = recentReads();
                cache.set('a.md', { fingerprint: 'fp1', at: new Date('2026-09-25T01:09:00Z'), chars: 3840 });
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, 120, 130), null, 'a line range must still return content');
                assert.strictEqual(unchangedReadNotice('a.md', 'fp1', cache, -1, 50), null, 'a partial read must still return content');
        });

        test('a changed file is never short-circuited', () => {
                const cache = recentReads();
                cache.set('a.md', { fingerprint: 'fp1', at: new Date(), chars: 10 });
                assert.strictEqual(unchangedReadNotice('a.md', 'fp2', cache, -1, -1), null);
        });

        test('a first read is never short-circuited', () => {
                assert.strictEqual(unchangedReadNotice('never-read.md', 'fp1', recentReads(), -1, -1), null);
        });
});

suite('runtime facts', () => {
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
