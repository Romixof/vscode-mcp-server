import * as assert from 'assert';
import { findNearMiss, noMatchMessage } from '../tools/edit-tools';

const HEAD = [
        '#!/usr/bin/env python3',
        '"""CloudVault generator."""',
        'import argparse',
        'import re',
        'import sys'
];

const B = String.fromCharCode(92);

const SVG_REAL = `if re.match(r'^<div class="svg-diagram(?:${B}s+[^"]+)?"><svg${B}s', line.strip()):`;
const SVG_QUOTED = `if re.match(r'^<div class="svg-diagram(?:${B}s+[^${B}"]+)?"><svg${B}s', line.strip()):`;

function fileWith(body: string, totalLines: number): string {
        const out = [...HEAD];
        for (let i = out.length; i < totalLines - 1; i += 1) { out.push(`line ${i + 1}`); }
        out.push(body);
        return out.join('\n');
}

suite('edit_file_code no-match reporting', () => {
        test('a stray backslash is found on the last line of a 618-line file', () => {
                const content = fileWith(SVG_REAL, 618);
                const near = findNearMiss(content, SVG_QUOTED);
                assert.ok(near, 'the near miss must be found');
                assert.strictEqual(near.line, 618, `expected line 618, got ${near.line}`);
                assert.ok(near.escaped, 'a backslash difference must be recognised as one');
        });

        test('the message points at the near miss and not at the head of the file', () => {
                const content = fileWith(SVG_REAL, 618);
                const message = noMatchMessage('generate_pdf.py', 618, content, SVG_QUOTED);
                assert.ok(!message.includes('#!/usr/bin/env python3'), 'the file head must not be shown');
                assert.ok(message.includes('closest line is 618'), `the near line must be named: ${message}`);
                assert.ok(/no backslashes added/.test(message), `the cause must be named: ${message}`);
                assert.ok(message.length < 400, `the message must stay small, got ${message.length} chars`);
        });

        test('a typo is reported at the closest line', () => {
                const content = fileWith('const timeoutMs = SHELL_TIMEOUT_MS;', 400);
                const message = noMatchMessage('shell-tools.ts', 400, content, 'const timeoutMs = SHELL_TIMEOUTM_S;');
                assert.ok(message.includes('closest line is 400'), `the near line must be named: ${message}`);
                assert.ok(/Match the text as it stands/.test(message), `the guidance must be given: ${message}`);
        });

        test('a needle that is a prefix of a line is a real match, not a near miss', () => {
                const content = fileWith('const timeoutMs = SHELL_TIMEOUT_MS;', 400);
                assert.strictEqual(
                        findNearMiss(content, 'const timeoutMs = SHELL_TIMEOUT_MS'),
                        null,
                        'a substring match must not be reported as a near miss'
                );
        });

        test('a short line is found even though it is under the prefix floor', () => {
                const content = fileWith('a = "b" + c', 500);
                const near = findNearMiss(content, `a = ${B}"b${B}" + c`);
                assert.ok(near, 'a backslash difference must be found whatever the line length');
                assert.strictEqual(near.line, 500);
                assert.ok(near.escaped);
        });

        test('a needle with nothing in common falls back to the head of the file', () => {
                const content = fileWith('something else entirely', 300);
                const message = noMatchMessage('x.ts', 300, content, 'zzz qqq vvv totally unrelated string');
                assert.ok(message.includes('#!/usr/bin/env python3'), 'the fallback must show the file head');
                assert.ok(/Read the file again/.test(message), 'the fallback must keep the old advice');
        });

        test('an empty needle never matches anything', () => {
                assert.strictEqual(findNearMiss('some content', ''), null);
                assert.strictEqual(findNearMiss('some content', '   \n  '), null);
        });

        test('the closest line wins over an earlier weaker one', () => {
                const content = ['prefix = 1', 'x = 2', 'const target = findNearMiss(content, needle);', 'y = 3'].join('\n');
                const near = findNearMiss(content, 'const target = findNearMiss(content, needles);');
                assert.ok(near, 'a near miss must be found');
                assert.strictEqual(near.line, 3);
        });

        test('a real match is not reported as a near miss', () => {
                const content = 'alpha\nbeta\ngamma\n';
                assert.strictEqual(findNearMiss(content, 'gamma'), null, 'an exact match is not a near miss');
        });

        test('the reported window is one line either side', () => {
                const content = ['l1', 'l2', 'l3', 'const needle = findNearMiss(a, b);', 'l5', 'l6'].join('\n');
                const near = findNearMiss(content, 'const needle = findNearMiss(a, c);');
                assert.ok(near);
                assert.strictEqual(near.context.split('\n').length, 3, 'the window must be 3 lines');
        });
});
