import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerFileTools } from '../tools/file-tools';

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const fixtures: string[] = [];

function fixturePath(name: string, bytes: Buffer): string {
        const dir = path.join(__dirname, '..', '..', '.test-fixtures');
        fs.mkdirSync(dir, { recursive: true });
        fixtures.push(dir);
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        return file;
}

function pngBytes(width: number, height: number): Buffer {
        const header = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
        header.writeUInt32BE(13, 8);
        header.write('IHDR', 12, 'latin1');
        header.writeUInt32BE(width, 16);
        header.writeUInt32BE(height, 20);
        return header;
}

function jpegBytes(): Buffer {
        return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20)]);
}

let readFile: ToolHandler;

suiteSetup(() => {
        const handlers = new Map<string, ToolHandler>();
        const fakeServer = {
                tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
                        handlers.set(name, handler);
                }
        } as unknown as McpServer;
        registerFileTools(fakeServer as McpServer, async () => []);
        const captured = handlers.get('read_file_code');
        assert.ok(captured, 'read_file_code was not registered');
        readFile = captured;
});

suiteTeardown(() => {
        for (const dir of fixtures) {
                fs.rmSync(dir, { recursive: true, force: true });
        }
});

function textOf(result: CallToolResult): string {
        return result.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
}

function imagesOf(result: CallToolResult): Array<{ mimeType?: string; data?: string }> {
        return result.content.filter(c => c.type === 'image') as Array<{ mimeType?: string; data?: string }>;
}

suite('read_file_code with images', () => {
        test('a PNG comes back as an image block, not as mojibake text', async () => {
                const file = fixturePath('shot.png', pngBytes(745, 1053));
                const result = await readFile({ path: file });
                const images = imagesOf(result);
                assert.strictEqual(images.length, 1, `expected one image block, got ${textOf(result).slice(0, 200)}`);
                assert.strictEqual(images[0].mimeType, 'image/png');
                assert.ok(!textOf(result).includes('PNG'), 'the raw bytes leaked into the text blocks');
        });

        test('the header states the dimensions and the token cost, and never repeats the payload', async () => {
                const file = fixturePath('costed.png', pngBytes(745, 1053));
                const result = await readFile({ path: file });
                const header = textOf(result);
                assert.ok(/745\s*[x×]\s*1053/.test(header), `the header must state the real dimensions. Got: ${header}`);
                assert.ok(/token/i.test(header), `the header must state what the image costs. Got: ${header}`);
                assert.ok(!header.includes('iVBORw0KGgo'), 'the base64 payload must never be echoed as text');
                assert.ok(header.length < 400, `the header must stay a caption, not a payload copy. Got ${header.length} chars`);
        });

        test('a JPEG is recognised too', async () => {
                const file = fixturePath('photo.jpg', jpegBytes());
                const result = await readFile({ path: file });
                const images = imagesOf(result);
                assert.strictEqual(images.length, 1, 'a JPEG should come back as an image');
                assert.strictEqual(images[0].mimeType, 'image/jpeg');
        });

        test('an explicit base64 request still returns base64 text', async () => {
                const file = fixturePath('explicit.png', pngBytes(10, 10));
                const result = await readFile({ path: file, encoding: 'base64' });
                assert.strictEqual(imagesOf(result).length, 0, 'the caller asked for text, so give text');
                assert.ok(textOf(result).includes('iVBORw0KGgo'), 'base64 output was expected');
        });

        test('a text file is untouched', async () => {
                const file = fixturePath('notes.txt', Buffer.from('hello world\nsecond line\n', 'utf-8'));
                const result = await readFile({ path: file });
                assert.strictEqual(imagesOf(result).length, 0, 'a text file must not become an image');
                assert.ok(textOf(result).includes('hello world'), `text content was lost: ${textOf(result)}`);
        });

        test('an oversized image is refused with a cheaper route, never truncated', async () => {
                const file = fixturePath('huge.png', Buffer.concat([pngBytes(4000, 6000), Buffer.alloc(6 * 1024 * 1024)]));
                const result = await readFile({ path: file });
                assert.strictEqual(imagesOf(result).length, 0, 'a multi-megabyte image must not be inlined whole');
                assert.ok(/render_pdf_pages_code|dpi/i.test(textOf(result)), `the refusal must point at a cheaper route. Got: ${textOf(result)}`);
        });

        test('a line range on a binary image is refused clearly instead of returning mojibake', async () => {
                const file = fixturePath('ranged.png', pngBytes(745, 1053));
                const result = await readFile({ path: file, startLine: 1, endLine: 5 });
                assert.strictEqual(imagesOf(result).length, 0, 'a line range does not apply to a bitmap');
                assert.ok(/image/i.test(textOf(result)), `the refusal must name the problem. Got: ${textOf(result)}`);
        });
});
