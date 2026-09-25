import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import proxyquire from 'proxyquire';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ShellStubOptions {
        pdfinfoFound: boolean;
        documentPages: number;
        raster?: 'ok' | 'timeout-after-writing' | 'hard-fail' | 'slow';
        budgetMs?: number;
}

function loadOcrTools(options: ShellStubOptions): { render: ToolHandler; executed: string[] } {
        const executed: string[] = [];
        const raster = options.raster ?? 'ok';
        const shellStub = {
                CLIENT_BUDGET_MS: options.budgetMs ?? 27000,
                async executeShellCommand(_terminal: unknown, command: string): Promise<{ output: string; exitCode: number }> {
                        executed.push(command);
                        if (command === 'command -v pdftoppm' || command === 'where.exe pdftoppm') {
                                return { output: '/usr/bin/pdftoppm\n', exitCode: 0 };
                        }
                        if (command === 'command -v pdfinfo' || command === 'where.exe pdfinfo') {
                                return options.pdfinfoFound
                                        ? { output: '/usr/bin/pdfinfo\n', exitCode: 0 }
                                        : { output: '', exitCode: 1 };
                        }
                        if (command.includes('pdfinfo')) {
                                return { output: `Title:           doc\nPages:           ${options.documentPages}\nPage size:      595 x 842 pts\n`, exitCode: 0 };
                        }
                        if (command.includes('pdftoppm')) {
                                if (raster === 'hard-fail') {
                                        return { output: 'bash: pdftoppm: command not found', exitCode: 127 };
                                }
                                const match = command.match(/'([^']+)'\s*$/);
                                if (match) {
                                        fs.writeFileSync(`${match[1]}-1.png`, 'not-really-a-png');
                                        fs.writeFileSync(`${match[1]}-2.png`, 'not-really-a-png');
                                }
                                if (raster === 'timeout-after-writing') {
                                        return { output: '\n\n[Timed out after 27000ms — showing the output captured so far.]', exitCode: 124 };
                                }
                                if (raster === 'slow') {
                                        await new Promise(resolve => setTimeout(resolve, (options.budgetMs ?? 27000) * 0.75));
                                }
                                return { output: '', exitCode: 0 };
                        }
                        return { output: '', exitCode: 1 };
                }
        };
        const ocrTools = proxyquire('../tools/ocr-tools', { './shell-tools': shellStub }) as
                typeof import('../tools/ocr-tools');
        const handlers = new Map<string, ToolHandler>();
        const fakeServer = {
                tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
                        handlers.set(name, handler);
                }
        } as unknown as McpServer;
        ocrTools.registerOcrTools(fakeServer);
        const render = handlers.get('render_pdf_pages_code');
        assert.ok(render, 'render_pdf_pages_code was not registered');
        return { render: render as ToolHandler, executed };
}

function fakePdf(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pdfcount-'));
        const file = path.join(dir, 'limites-et-continuite.pdf');
        fs.writeFileSync(file, 'not-really-a-pdf');
        return file;
}

function firstText(result: CallToolResult): string {
        const block = result.content.find(c => c.type === 'text');
        assert.ok(block && block.type === 'text', 'the tool returned no text block');
        return block.text;
}

suite('render_pdf_pages_code page count', () => {
        test('reports how many pages the document has in total, not just how many were rendered', async () => {
                const pdf = fakePdf();
                const { render } = loadOcrTools({ pdfinfoFound: true, documentPages: 5 });
                const result = await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 72 });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(
                        /of 5\b/.test(text),
                        `the summary must state the 5-page total so a 2-page render is not mistaken for the whole document. Got: ${text}`
                );
                assert.ok(
                        /page\(s\) of this document were not rendered/i.test(text),
                        `the summary must say how many pages are still unread. Got: ${text}`
                );
        });

        test('still renders the images when pdfinfo is missing, and says the total is unknown', async () => {
                const pdf = fakePdf();
                const { render } = loadOcrTools({ pdfinfoFound: false, documentPages: 0 });
                const result = await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 72 });
                assert.ok(!result.isError, `a missing pdfinfo must not fail the render: ${firstText(result)}`);
                const text = firstText(result);
                assert.strictEqual(result.content.filter(c => c.type === 'image').length, 2, 'both pages should still come back as images');
                assert.ok(
                        /total page count unknown/i.test(text),
                        `without pdfinfo the tool must admit it does not know the total. Got: ${text}`
                );
                assert.ok(
                        /do not assume this is the whole document/i.test(text),
                        `the wording must stop the model reading a partial render as the full document. Got: ${text}`
                );
        });

        test('a slow raster that finished anyway is used instead of thrown away', async () => {
                const pdf = fakePdf();
                const { render } = loadOcrTools({ pdfinfoFound: true, documentPages: 5, raster: 'timeout-after-writing' });
                const result = await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 100 });
                assert.ok(!result.isError, `a run that wrote its images must not be reported as a failure: ${firstText(result)}`);
                assert.strictEqual(
                        result.content.filter(c => c.type === 'image').length,
                        2,
                        'both pages pdftoppm managed to write should come back'
                );
        });

        test('a raster that produced nothing still fails, with the shell output', async () => {
                const pdf = fakePdf();
                const { render } = loadOcrTools({ pdfinfoFound: true, documentPages: 5, raster: 'hard-fail' });
                const result = await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 100 });
                assert.ok(result.isError, 'a genuine failure must not be reported as a success');
                assert.ok(/command not found/.test(firstText(result)), `the shell output should be surfaced. Got: ${firstText(result)}`);
        });

        test('a skipped page count says the budget ran out, not that pdfinfo is missing', async () => {
                const pdf = fakePdf();
                const { render } = loadOcrTools({ pdfinfoFound: true, documentPages: 5, raster: 'slow', budgetMs: 2000 });
                const text = firstText(await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 100 }));
                assert.ok(
                        !/not found/i.test(text),
                        `pdfinfo is installed here, so claiming it is missing sends the reader down a pointless install. Got: ${text}`
                );
                assert.ok(
                        /time budget|no time|ran out/i.test(text),
                        `the reason must name the time budget. Got: ${text}`
                );
        });

        test('a slow raster drops the page count rather than overrunning the client', async () => {
                const pdf = fakePdf();
                const { render, executed } = loadOcrTools({ pdfinfoFound: true, documentPages: 5, raster: 'slow', budgetMs: 2000 });
                const result = await render({ pdfPath: pdf, firstPage: 1, lastPage: 2, dpi: 100 });
                assert.ok(!result.isError, `the pages must still come back: ${firstText(result)}`);
                assert.strictEqual(
                        result.content.filter(c => c.type === 'image').length,
                        2,
                        'a metadata lookup must never cost us the rendered pages'
                );
                assert.ok(
                        !executed.some(c => c.includes('pdfinfo') && !c.startsWith('command -v')),
                        `pdfinfo must not run once the budget is spent, or the response arrives after the client gave up. Ran: ${executed.join(' | ')}`
                );
                assert.ok(
                        /total page count unknown/i.test(firstText(result)),
                        `with no budget left the tool must say the total is unknown. Got: ${firstText(result)}`
                );
                assert.ok(
                        !/total page count unknown \(pdfinfo not found\)/i.test(firstText(result)),
                        `the missing-binary wording is reserved for a real absence. Got: ${firstText(result)}`
                );
        });
});
