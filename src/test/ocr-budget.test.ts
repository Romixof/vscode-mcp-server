import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import proxyquire from 'proxyquire';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface SlowOcrOptions {
        budgetMs: number;
        rasterDelayMs: number;
        /** Real-life CLIENT_BUDGET_MS the tool clamps its internal deadline against. Defaults to budgetMs. */
        clientTimeoutMs?: number;
        pageTexts?: string[];
        tesseractFound?: boolean;
}

function loadOcrTools(options: SlowOcrOptions): { ocr: ToolHandler; executed: string[] } {
        const executed: string[] = [];
        const shellStub = {
                CLIENT_BUDGET_MS: options.clientTimeoutMs ?? options.budgetMs,
                async executeShellCommand(_terminal: unknown, command: string, _cwd: unknown, timeout?: number): Promise<{ output: string; exitCode: number }> {
                        executed.push(command);
                        if (command.startsWith('test -f ')) {
                                return { output: '', exitCode: 1 };
                        }
                        const probeMatch = command.match(/^(?:command -v|where\.exe) (\S+)$/);
                        if (probeMatch) {
                                const bin = probeMatch[1];
                                const found = bin === 'pdftoppm' || bin === 'pdftotext'
                                        ? true
                                        : (options.tesseractFound ?? true);
                                return found ? { output: `/usr/bin/${bin}\n`, exitCode: 0 } : { output: '', exitCode: 1 };
                        }
                        if (command.includes('pdftotext') && !command.includes('-png')) {
                                return { output: '', exitCode: 1 };
                        }
                        if (command.includes('pdftoppm')) {
                                await new Promise(resolve => setTimeout(resolve, options.rasterDelayMs));
                                const elapsed = options.rasterDelayMs;
                                if (elapsed >= (timeout ?? 0)) {
                                        return { output: '[Timed out]', exitCode: 124 };
                                }
                                const match = command.match(/'([^']+)'\s*$/);
                                if (match) {
                                        fs.writeFileSync(`${match[1]}-1.png`, 'not-really-a-png');
                                }
                                return { output: '', exitCode: 0 };
                        }
                        if (command.includes('tesseract')) {
                                return { output: 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\nx\ty\t1\t1\t1\t1\t1\t1\t1\t1\t95\tpage text\n', exitCode: 0 };
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
        const ocr = handlers.get('ocr_pdf_code');
        assert.ok(ocr, 'ocr_pdf_code was not registered');
        return { ocr, executed };
}

function fakePdf(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ocrbudget-'));
        const file = path.join(dir, 'cours.pdf');
        fs.writeFileSync(file, 'not-really-a-pdf');
        return file;
}

function firstText(result: CallToolResult): string {
        const block = result.content.find(c => c.type === 'text');
        assert.ok(block && block.type === 'text', 'the tool returned no text block');
        return block.text;
}

suite('ocr_pdf_code budget discipline', () => {
        test('a raster that ate the budget still returns, marked as partial with a resume hint', async () => {
                const pdf = fakePdf();
                const { ocr } = loadOcrTools({ budgetMs: 27000, rasterDelayMs: 300 });
                const result = await ocr({ pdfPath: pdf, engine: 'tesseract', timeoutMs: 500, dpi: 72 });
                assert.ok(!result.isError, `the partial result must not surface as an unhandled error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/time budget/i.test(text), `the partial header must say the budget ran out. Got: ${text}`);
                assert.ok(/later firstPage|continue OCR/i.test(text), `the partial result must carry a resume hint. Got: ${text}`);
        });

        test('no page image at all after a starved raster is a bounded error naming dpi or range, not a hang', async () => {
                const pdf = fakePdf();
                // The tool clamps its raster timeout to a 1000ms floor, so starve past that,
                // not past a theoretical tiny timeout that can never be granted.
                const { ocr } = loadOcrTools({ budgetMs: 27000, rasterDelayMs: 1300, clientTimeoutMs: 1100 });
                const result = await ocr({ pdfPath: pdf, engine: 'tesseract', dpi: 72 });
                assert.ok(result.isError, 'no pages rasterized must be an error');
                const text = firstText(result);
                assert.ok(/time budget|narrower page range|dpi=150/.test(text), `the error must explain the budget, not blame binaries. Got: ${text}`);
        });

        test('the whole tesseract pipeline still succeeds inside the budget when pages are quick', async () => {
                const pdf = fakePdf();
                const { ocr } = loadOcrTools({ budgetMs: 27000, rasterDelayMs: 10 });
                const result = await ocr({ pdfPath: pdf, engine: 'tesseract', dpi: 72 });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/--- Page 1 \(tesseract\) ---/.test(text), `page text missing. Got: ${text}`);
                assert.ok(/page text/.test(text), `tesseract output missing. Got: ${text}`);
        });
});
