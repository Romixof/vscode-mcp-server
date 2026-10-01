import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import proxyquire from 'proxyquire';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ShellStubOptions {
        pdftotextFound: boolean;
        pageTexts: string[];
        pdftotextFails?: boolean;
        tesseractFound?: boolean;
        raster?: 'ok' | 'fail';
}

function loadOcrTools(options: ShellStubOptions): { ocr: ToolHandler; executed: string[]; handlers: Map<string, ToolHandler> } {
        const executed: string[] = [];
        const raster = options.raster ?? 'fail';
        const shellStub = {
                CLIENT_BUDGET_MS: 27000,
                async executeShellCommand(_terminal: unknown, command: string): Promise<{ output: string; exitCode: number }> {
                        executed.push(command);
                        if (command.startsWith('test -f ')) {
                                return { output: '', exitCode: 1 };
                        }
                        const probeMatch = command.match(/^(?:command -v|where\.exe) (\S+)$/);
                        if (probeMatch) {
                                const bin = probeMatch[1];
                                const found = bin === 'pdftotext' ? options.pdftotextFound
                                        : bin === 'tesseract' ? (options.tesseractFound ?? false)
                                        : bin === 'pdftoppm' ? true
                                        : false;
                                return found ? { output: `/usr/bin/${bin}\n`, exitCode: 0 } : { output: '', exitCode: 1 };
                        }
                        if (command.includes('pdftotext')) {
                                if (options.pdftotextFails) {
                                        return { output: 'pdftotext: unexpected error', exitCode: 1 };
                                }
                                return { output: options.pageTexts.join('\f'), exitCode: 0 };
                        }
                        if (command.includes('pdftoppm')) {
                                if (raster === 'fail') {
                                        return { output: 'bash: pdftoppm: command not found', exitCode: 127 };
                                }
                                const match = command.match(/'([^']+)'\s*$/);
                                if (match) {
                                        fs.writeFileSync(`${match[1]}-1.png`, 'not-really-a-png');
                                }
                                return { output: '', exitCode: 0 };
                        }
                        if (command.includes('tesseract')) {
                                return { output: 'x\ty\t1\t1\t1\t1\t1\t1\t1\t1\t95\tpage text\t95\tpage text\n', exitCode: 0 };
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
        return { ocr, executed, handlers };
}

function fakePdf(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-textlayer-'));
        const file = path.join(dir, 'cours.pdf');
        fs.writeFileSync(file, 'not-really-a-pdf');
        return file;
}

function firstText(result: CallToolResult): string {
        const block = result.content.find(c => c.type === 'text');
        assert.ok(block && block.type === 'text', 'the tool returned no text block');
        return block.text;
}

const GOOD = 'Voici une page avec suffisamment de texte pour passer le seuil.';
const GOOD2 = 'Deuxieme page, encore du texte en quantite suffisante ici.';
const GOOD3 = 'Troisieme page, toujours du texte a lire en quantite.';

suite('ocr_pdf_code text-layer fast path', () => {
        test('engine auto on a text-layer PDF returns the text without rasterizing or tesseract', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, GOOD2]
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto', language: 'fra' });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/Text layer found/.test(text), `missing header. Got: ${text}`);
                assert.ok(/no OCR needed/.test(text), `header must say no OCR was needed. Got: ${text}`);
                assert.ok(/--- Page 1 \(text layer\) ---/.test(text), `page 1 missing. Got: ${text}`);
                assert.ok(/--- Page 2 \(text layer\) ---/.test(text), `page 2 missing. Got: ${text}`);
                assert.ok(text.includes(GOOD), `page text not returned verbatim. Got: ${text}`);
                assert.ok(!executed.some(c => c.includes('pdftoppm')), `no rasterization needed. Ran: ${executed.join(' | ')}`);
                assert.ok(!executed.some(c => c.includes('tesseract')), `no tesseract needed. Ran: ${executed.join(' | ')}`);
        });

        test('a mixed PDF returns the readable pages and marks the scanned ones', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, GOOD2, GOOD3, 'tiny page']
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto' });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/--- Page 1 \(text layer\) ---/.test(text), `page 1 missing. Got: ${text}`);
                assert.ok(/--- Page 3 \(text layer\) ---/.test(text), `page 3 missing. Got: ${text}`);
                assert.ok(/--- Page 4 \(no text layer\) ---/.test(text), `scanned page 4 not marked. Got: ${text}`);
                assert.ok(/Page 4: scanned, no usable text layer/.test(text), `scanned page needs a next-call hint. Got: ${text}`);
                assert.ok(/1 page\(s\) had no usable text layer/.test(text), `header must count scanned pages. Got: ${text}`);
                assert.ok(!executed.some(c => c.includes('pdftoppm') || c.includes('tesseract')), `majority-text must not reach the OCR engines. Ran: ${executed.join(' | ')}`);
        });

        test('a majority-scanned PDF falls through to the OCR engines', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, 'x', 'y'],
                        tesseractFound: false
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto' });
                assert.ok(result.isError, 'majority-scanned must fall through to the OCR engines, which then need tesseract');
                assert.ok(/tesseract/.test(firstText(result)), `fall-through error must name tesseract. Got: ${firstText(result)}`);
                assert.ok(executed.some(c => c.includes('pdftotext')), `pdftotext must have been tried first. Ran: ${executed.join(' | ')}`);
        });

        test('a missing pdftotext falls through to the OCR engines too', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: false,
                        pageTexts: [GOOD],
                        tesseractFound: false
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto' });
                assert.ok(result.isError, 'without pdftotext the OCR path must run and demand tesseract');
                assert.ok(/tesseract/.test(firstText(result)), `expected the tesseract requirement. Got: ${firstText(result)}`);
                assert.ok(executed.some(c => /(?:command -v|where\.exe) tesseract/.test(c)), `tesseract must be probed. Ran: ${executed.join(' | ')}`);
        });

        test('page numbering follows firstPage and the range is passed through', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, GOOD2]
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto', firstPage: 21, lastPage: 22 });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/--- Page 21 \(text layer\) ---/.test(text), `numbering must start at 21. Got: ${text}`);
                assert.ok(/--- Page 22 \(text layer\) ---/.test(text), `page 22 missing. Got: ${text}`);
                const run = executed.find(c => c.includes('pdftotext') && !/^(?:command -v|where\.exe)/.test(c));
                assert.ok(run, 'pdftotext never ran');
                assert.ok(/-f 21/.test(run!), `range start missing. Got: ${run}`);
                assert.ok(/-l 22/.test(run!), `range end missing. Got: ${run}`);
        });

        test('no range returns the whole document', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, GOOD2, GOOD3]
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto' });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/3 page\(s\) read directly/.test(text), `all pages must come back. Got: ${text}`);
                assert.ok(/--- Page 3 \(text layer\) ---/.test(text), `page 3 missing. Got: ${text}`);
                const run = executed.find(c => c.includes('pdftotext') && !/^(?:command -v|where\.exe)/.test(c));
                assert.ok(run && !/-f \d|-l \d/.test(run), `no range must be passed. Got: ${run}`);
        });

        test('explicit tesseract never enters the fast path on the same text PDF', async () => {
                const pdf = fakePdf();
                const { ocr, executed } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD, GOOD2],
                        tesseractFound: false
                });
                const result = await ocr({ pdfPath: pdf, engine: 'tesseract' });
                assert.ok(result.isError, 'tesseract engine without tesseract must fail');
                assert.ok(/tesseract/.test(firstText(result)), `expected the tesseract requirement. Got: ${firstText(result)}`);
                assert.ok(!executed.some(c => c.includes('pdftotext')), `the fast path is auto-only. Ran: ${executed.join(' | ')}`);
        });

        test('a pdftotext failure falls through instead of reporting a text layer', async () => {
                const pdf = fakePdf();
                const { ocr } = loadOcrTools({
                        pdftotextFound: true,
                        pageTexts: [GOOD],
                        pdftotextFails: true,
                        tesseractFound: false
                });
                const result = await ocr({ pdfPath: pdf, engine: 'auto' });
                assert.ok(result.isError, 'a failed extraction must fall through to the OCR engines');
                assert.ok(/tesseract/.test(firstText(result)), `expected the tesseract requirement. Got: ${firstText(result)}`);
        });

        test('outputPath saves the text-layer result', async () => {
                const pdf = fakePdf();
                const outFile = path.join(os.tmpdir(), `mcp-textlayer-out-${Date.now()}.txt`);
                try {
                        const { ocr } = loadOcrTools({ pdftotextFound: true, pageTexts: [GOOD, GOOD2] });
                        const result = await ocr({ pdfPath: pdf, engine: 'auto', outputPath: outFile });
                        assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                        const text = firstText(result);
                        assert.ok(/Full text saved/.test(text), `save note missing. Got: ${text}`);
                        assert.ok(fs.existsSync(outFile), 'the output file was not written');
                        const saved = fs.readFileSync(outFile, 'utf-8');
                        assert.ok(saved.includes(GOOD), 'saved file must contain the page text');
                        assert.ok(/--- Page 2 \(text layer\) ---/.test(saved), 'saved file must be the structured text');
                } finally {
                        fs.rmSync(outFile, { force: true });
                }
        });

        test('append accumulates into an existing output file', async () => {
                const pdf = fakePdf();
                const outFile = path.join(os.tmpdir(), `mcp-textlayer-append-${Date.now()}.txt`);
                try {
                        fs.writeFileSync(outFile, 'EXISTING\n');
                        const { ocr } = loadOcrTools({ pdftotextFound: true, pageTexts: [GOOD] });
                        const result = await ocr({ pdfPath: pdf, engine: 'auto', outputPath: outFile, append: true });
                        assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                        assert.ok(/Appended to/.test(firstText(result)), `append note missing. Got: ${firstText(result)}`);
                        const saved = fs.readFileSync(outFile, 'utf-8');
                        assert.ok(saved.startsWith('EXISTING'), 'existing content must be kept');
                        assert.ok(saved.includes(GOOD), 'new content must be appended');
                } finally {
                        fs.rmSync(outFile, { force: true });
                }
        });

        test('a range wider than the cap is still rejected with the split instruction', async () => {
                const pdf = fakePdf();
                const { ocr } = loadOcrTools({ pdftotextFound: true, pageTexts: [GOOD, GOOD2], tesseractFound: false });
                const result = await ocr({ pdfPath: pdf, engine: 'tesseract', firstPage: 1, lastPage: 28 });
                assert.ok(result.isError, 'a wide explicit range on the raster path must be rejected');
                const text = firstText(result);
                assert.ok(/capped at 15/.test(text), `cap must be named. Got: ${text}`);
                assert.ok(/Split into multiple calls/.test(text), `split instruction missing. Got: ${text}`);
        });

        test('the pdf_needs_ocr verdict points at the auto fast path', async () => {
                const pdf = fakePdf();
                const { handlers } = loadOcrTools({ pdftotextFound: true, pageTexts: [GOOD, GOOD2] });
                const needsOcr = handlers.get('pdf_needs_ocr_code');
                assert.ok(needsOcr, 'pdf_needs_ocr_code was not registered');
                const result = await needsOcr({ pdfPath: pdf });
                assert.ok(!result.isError, `unexpected error: ${firstText(result)}`);
                const text = firstText(result);
                assert.ok(/TEXTE EXTRACTIBLE/.test(text), `a text-layer PDF must get the no-OCR verdict. Got: ${text}`);
                assert.ok(/ocr_pdf_code\(engine="auto"\)/.test(text), `the verdict must point at the auto fast path. Got: ${text}`);
        });
});
