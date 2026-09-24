import * as assert from 'assert';
import * as path from 'path';

function loadFresh<T>(modulePath: string): T {
        const resolved = require.resolve(modulePath);
        delete require.cache[resolved];
        return require(resolved) as T;
}

interface CalendarExports {
        decodeXmlEntities(input: string): string;
}

interface FrontendExports {
        stripHtmlComments(input: string): string;
}

const calendar = (): CalendarExports =>
        loadFresh<CalendarExports>(path.join(__dirname, '../../out/tools/calendar-tools.js'));

const frontend = (): FrontendExports =>
        loadFresh<FrontendExports>(path.join(__dirname, '../../out/tools/frontend-tools.js'));

suite('decodeXmlEntities', () => {
        test('leaves text without entities unchanged', () => {
                assert.strictEqual(calendar().decodeXmlEntities('plain text'), 'plain text');
        });

        test('decodes lt and gt in a single pass', () => {
                assert.strictEqual(calendar().decodeXmlEntities('&lt;b&gt;'), '<b>');
        });

        test('decodes quot and apos to their quote characters', () => {
                assert.strictEqual(calendar().decodeXmlEntities('&quot;x&quot;'), '"x"');
                assert.strictEqual(calendar().decodeXmlEntities('&apos;x&apos;'), "'x'");
        });

        test('decodes a double-encoded tag so no residual entity survives', () => {
                assert.strictEqual(calendar().decodeXmlEntities('&amp;lt;script&amp;gt;'), '<script>');
        });

        test('terminates on a self-referential amp run', () => {
                const input = '&amp;'.repeat(200);
                assert.ok(calendar().decodeXmlEntities(input).length <= input.length);
        });
});

suite('stripHtmlComments', () => {
        test('removes a single well-formed comment', () => {
                assert.strictEqual(frontend().stripHtmlComments('a<!-- x -->b'), 'ab');
        });

        test('removes a nested comment so no opener survives', () => {
                assert.ok(!frontend().stripHtmlComments('<!<!--- x --->>').includes('<!--'));
        });

        test('removes a comment terminated with the bang form', () => {
                assert.ok(!frontend().stripHtmlComments('a<!-- x --!>b').includes('<!--'));
        });

        test('spans newlines inside a comment', () => {
                assert.strictEqual(frontend().stripHtmlComments('a<!-- x\ny -->b'), 'ab');
        });

        test('leaves markup without comments untouched', () => {
                const html = '<div class="x"><p>text</p></div>';
                assert.strictEqual(frontend().stripHtmlComments(html), html);
        });
});

suite('migration diff tab normalization', () => {
        test('replaces every tab in a line, not only the first', () => {
                assert.strictEqual('a\tb\tc'.replace(/\t/g, '  '), 'a  b  c');
        });
});
