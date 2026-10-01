import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerFileTools } from '../tools/file-tools';

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const fixtures: string[] = [];

function writeFixture(name: string, text: string): string {
        const dir = path.join(__dirname, '..', '..', '.test-fixtures');
        fs.mkdirSync(dir, { recursive: true });
        fixtures.push(dir);
        const file = path.join(dir, name);
        fs.writeFileSync(file, text);
        return file;
}

let readFile: ToolHandler;

function textOf(result: CallToolResult): string {
        return (result.content as Array<{ type: string; text?: string }>).map(c => c.text ?? '').join('');
}

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
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
});

suite('a second read of the same file is refused at the tool boundary', () => {
        test('a full read, then the same full read as a huge line range', async () => {
                const body = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the transcript`).join('\n');
                const file = writeFixture('dedupe-full.txt', body);

                const first = await readFile({ path: file });
                assert.ok(textOf(first).includes('line 400'), 'the first read must return the file');

                const second = await readFile({ path: file });
                assert.ok(/unchanged/i.test(textOf(second)), `the second read must be a notice: ${textOf(second)}`);

                const asRange = await readFile({ path: file, startLine: 1, endLine: 100000 });
                assert.ok(/unchanged/i.test(textOf(asRange)), `startLine 1 with a huge endLine must not return the file again: ${textOf(asRange).slice(0, 200)}`);
                assert.ok(!textOf(asRange).includes('line 400'), 'the body must not come back');
        });

        test('a section read twice is refused the second time', async () => {
                const body = Array.from({ length: 400 }, (_, i) => `row ${i + 1}`).join('\n');
                const file = writeFixture('dedupe-section.txt', body);

                const first = await readFile({ path: file, startLine: 100, endLine: 120 });
                assert.ok(textOf(first).includes('row 100'), 'the first section read must return content');

                const second = await readFile({ path: file, startLine: 100, endLine: 120 });
                assert.ok(/unchanged/i.test(textOf(second)), `the same section twice must be refused: ${textOf(second)}`);
                assert.ok(!textOf(second).includes('row 100'), 'the section must not come back');

                const other = await readFile({ path: file, startLine: 200, endLine: 220 });
                assert.ok(textOf(other).includes('row 200'), 'a different section must still return content');
        });

        test('a section read does not make a later full read look cached', async () => {
                const body = Array.from({ length: 400 }, (_, i) => `item ${i + 1}`).join('\n');
                const file = writeFixture('dedupe-section-then-full.txt', body);

                await readFile({ path: file, startLine: 10, endLine: 20 });
                const full = await readFile({ path: file });
                assert.ok(textOf(full).includes('item 400'), 'a full read after a section read must still return the whole file');
        });

        test('an edited file is read again', async () => {
                const file = writeFixture('dedupe-edited.txt', Array.from({ length: 400 }, (_, i) => `v1 line ${i + 1}`).join('\n'));

                await readFile({ path: file });
                const notice = await readFile({ path: file });
                assert.ok(/unchanged/i.test(textOf(notice)), 'the unchanged re-read must be refused');

                const future = new Date(Date.now() + 5000);
                fs.utimesSync(file, future, future);
                fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `v2 line ${i + 1}`).join('\n'));

                const afterEdit = await readFile({ path: file });
                assert.ok(textOf(afterEdit).includes('v2 line 400'), 'an edited file must be returned again');
        });
});

suite('a binary file is refused instead of decoded as text', () => {
        test('a PDF points at the tool that reads it', async () => {
                const dir = path.join(__dirname, '..', '..', '.test-fixtures');
                fs.mkdirSync(dir, { recursive: true });
                fixtures.push(dir);
                const file = path.join(dir, 'binary.pdf');
                const bytes = Buffer.concat([
                        Buffer.from('%PDF-1.7\n'),
                        Buffer.from([0x78, 0x9c, 0x00, 0x01, 0x02, 0x03]),
                        Buffer.from('endobj\n')
                ]);
                fs.writeFileSync(file, bytes);

                await assert.rejects(
                        () => readFile({ path: file }),
                        (error: Error) => {
                                assert.ok(/binary/i.test(error.message), error.message);
                                assert.ok(error.message.includes('render_pdf_pages_code'), `must name the route: ${error.message}`);
                                assert.ok(!error.message.includes('FlateDecode'), 'must not leak file bytes into the message');
                                return true;
                        }
                );
        });

        test('the refusal ends with the exact call to make', async () => {
                const dir = path.join(__dirname, '..', '..', '.test-fixtures');
                fs.mkdirSync(dir, { recursive: true });
                fixtures.push(dir);
                const file = path.join(dir, 'binary.pdf');
                fs.writeFileSync(file, Buffer.concat([
                        Buffer.from('%PDF-1.7\n'),
                        Buffer.from([0x78, 0x9c, 0x00, 0x01, 0x02, 0x03]),
                        Buffer.from('endobj\n')
                ]));

                await assert.rejects(
                        () => readFile({ path: file }),
                        (error: Error) => {
                                const lines = error.message.trimEnd().split('\n');
                                const last = lines[lines.length - 1];
                                assert.ok(
                                        last.includes('[@vscode-mcp:') && last.includes('ocr_pdf_code'),
                                        `refusal must end with the machine-readable next call: ${last}`
                                );
                                assert.ok(
                                        last.includes(JSON.stringify(file)),
                                        `the next call must carry the real path, not a placeholder: ${last}`
                                );
                                return true;
                        }
                );
        });

        test('a text file is unaffected', async () => {
                const file = writeFixture('plain.txt', 'hello\nworld\n');
                const result = await readFile({ path: file });
                assert.ok(textOf(result).includes('hello'), 'text must still be returned as text');
        });
});
