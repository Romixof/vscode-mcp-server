import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { executeShellCommand, CLIENT_BUDGET_MS } from './shell-tools';
import { compactOcrText, rememberOriginal, formatCompactionNotice } from '../utils/token-efficiency';
import { assertUrlSafe } from '../utils/security-helpers';
import { WINDOWS_FALLBACK_DIRS, findGitBash, POPPLER_HINT, windowsBinaryExists } from '../utils/binaries';

const DEFAULT_MIN_CHARS_PER_PAGE = 20;
const DEFAULT_DPI = 300;
const DEFAULT_RENDER_DPI = 200;
const DEFAULT_MAX_INLINE_CHARS = 20000;
const MAX_RENDER_PAGES = 8;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_VISION_MODEL = 'llama3.2-vision';
const DEFAULT_VISION_CONFIDENCE_THRESHOLD = 70;
const MAX_PAGES_PER_CALL = {
    tesseract: 15,
    auto: 6,
    vision: 3
};
const DEFAULT_OCR_TIMEOUT_MS = 25000;
const MIN_METADATA_BUDGET_MS = 1000;
const PDFINFO_TIMEOUT_MS = 2000;
function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
const OCR_TERMINAL_NAME = 'MCP OCR';
function getOcrTerminal(): vscode.Terminal {
    const existing = vscode.window.terminals.find(t => t.name === OCR_TERMINAL_NAME && t.exitStatus === undefined);
    if (existing) {
        return existing;
    }
    const bashPath = findGitBash();
    return bashPath
        ? vscode.window.createTerminal({ name: OCR_TERMINAL_NAME, shellPath: bashPath })
        : vscode.window.createTerminal(OCR_TERMINAL_NAME);
}
async function resolveBinary(terminal: vscode.Terminal, cwd: string, bin: string, timeoutMs: number = 5000): Promise<string | undefined> {
    const check = await executeShellCommand(terminal, `command -v ${bin}`, cwd, timeoutMs).catch(() => ({ output: '', exitCode: 1 }));
    if (check.exitCode === 0) {
        return bin;
    }
    const winCheck = await executeShellCommand(terminal, `where.exe ${bin}`, cwd, timeoutMs).catch(() => ({ output: '', exitCode: 1 }));
    if (winCheck.exitCode === 0) {
        return bin;
    }
    for (const dir of WINDOWS_FALLBACK_DIRS[bin] || []) {
        const exePath = `${dir}/${bin}.exe`;

        const probe = await executeShellCommand(terminal, `test -f ${shellSingleQuote(exePath)}`, cwd, timeoutMs).catch(() => ({ output: '', exitCode: 1 }));
        if (probe.exitCode === 0) {
            return exePath;
        }
    }
    if (process.platform === 'win32' && (WINDOWS_FALLBACK_DIRS[bin] || []).some(dir => windowsBinaryExists(dir, bin))) {
        return (WINDOWS_FALLBACK_DIRS[bin] || []).map(dir => `${dir}/${bin}.exe`).find(p => windowsBinaryExists(path.dirname(p), bin));
    }
    return undefined;
}
function missingBinaryMessage(bin: string, installHint: string): string {
    const fallbackNote = WINDOWS_FALLBACK_DIRS[bin]
        ? ` Also checked the usual Windows install location(s) (${WINDOWS_FALLBACK_DIRS[bin].join(', ')}) and found nothing there either — if you just installed it, verify the install actually completed (reinstall if needed), or check "Add to PATH" was enabled during setup.`
        : '';
    return `"${bin}" is not available on PATH — install ${installHint}.${fallbackNote} `
        + 'If you just installed it and this still fails, fully quit and relaunch VS Code (not just the terminal) — '
        + 'a PATH change made by an installer is not visible to a process, like VS Code, that was already running when it happened. Run get_server_info_code for the full binary picture on this machine.';
}
function splitPages(rawText: string): string[] {
    const pages = rawText.split('\f');
    if (pages.length > 1 && pages[pages.length - 1].trim() === '') {
        pages.pop();
    }
    return pages;
}
function parseTsv(output: string): { text: string; confidence: number } {
    const lines = output.split(/\r?\n/).slice(1);
    const byLine = new Map<string, string[]>();
    let confSum = 0;
    let confCount = 0;
    for (const line of lines) {
        const cols = line.split('\t');
        if (cols.length < 12) {
            continue;
        }
        const [, , blockNum, parNum, lineNum, , , , , , conf, ...textParts] = cols;
        const text = textParts.join('\t').trim();
        if (!text) {
            continue;
        }
        const key = `${blockNum}-${parNum}-${lineNum}`;
        if (!byLine.has(key)) {
            byLine.set(key, []);
        }
        byLine.get(key)!.push(text);
        const c = parseFloat(conf);
        if (!isNaN(c) && c >= 0) {
            confSum += c;
            confCount++;
        }
    }
    const text = [...byLine.values()].map(words => words.join(' ')).join('\n');
    const confidence = confCount > 0 ? confSum / confCount : 0;
    return { text, confidence };
}
const TRANSCRIBE_PROMPT_BASE = 'Transcribe every word visible on this image EXACTLY as written, including any '
    + 'handwritten text, margin notes, and faint or low-contrast text. Preserve line breaks and layout order as '
    + 'closely as practical, as plain text.';
const TRANSCRIBE_PROMPT_TAIL = ' If a word or character is genuinely illegible, write [illisible] in its place '
    + 'rather than guessing. Output ONLY the transcription — no preamble, no commentary, no markdown formatting.';
async function checkOllamaModel(ollamaUrl: string, model: string, timeoutMs = 5000): Promise<{ ok: boolean; reason?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
        if (!res.ok) {
            return { ok: false, reason: `Ollama responded with HTTP ${res.status} at ${ollamaUrl}.` };
        }
        const data = await res.json();
        const names: string[] = (data.models || []).map((m: any) => String(m.name || m.model || ''));
        const baseModel = model.split(':')[0];
        const hasModel = names.some(n => n === model || n.split(':')[0] === baseModel);
        if (!hasModel) {
            return {
                ok: false,
                reason: `Ollama is running but "${model}" isn't pulled yet — run "ollama pull ${model}" first. `
                    + `Installed models: ${names.join(', ') || '(none)'}.`
            };
        }
        return { ok: true };
    }
    catch {
        return {
            ok: false,
            reason: `Could not reach Ollama at ${ollamaUrl} — install it from https://ollama.com, make sure it's running `
                + `("ollama serve", or just launch the desktop app), then "ollama pull ${model}".`
        };
    }
    finally {
        clearTimeout(timer);
    }
}
async function callLocalVisionOcr(ollamaUrl: string, model: string, imageBase64: string, languageHint: string, timeoutMs: number): Promise<string> {
    const langLine = languageHint ? ` The document is primarily in "${languageHint}".` : '';
    const prompt = TRANSCRIBE_PROMPT_BASE + langLine + TRANSCRIBE_PROMPT_TAIL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false }),
            signal: controller.signal
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Ollama error ${res.status}: ${errText.slice(0, 300)}`);
        }
        const data = await res.json();
        return typeof data.response === 'string' ? data.response.trim() : '';
    }
    catch (e) {
        if ((e as { name?: string } | undefined)?.name === 'AbortError') {
            throw new Error(`Ollama request timed out after ${timeoutMs}ms — local vision models can be slow on CPU; try a smaller model or raise timeoutMs.`);
        }
        throw e;
    }
    finally {
        clearTimeout(timer);
    }
}
async function runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= tasks.length) {
                return;
            }
            await tasks[i]();
        }
    });
    await Promise.all(workers);
}
async function tryTextLayer(options: {
    fileUri: vscode.Uri;
    firstPage: number | undefined;
    lastPage: number | undefined;
    budgetLeft: () => number;
    outputPath: string | undefined;
    append: boolean;
    workspace: string | undefined;
}): Promise<CallToolResult | undefined> {
    const { fileUri, firstPage, lastPage, budgetLeft, outputPath, append, workspace } = options;
    const terminal = getOcrTerminal();
    const cwd = path.dirname(fileUri.fsPath);
    const pdftotextBin = await resolveBinary(terminal, cwd, 'pdftotext');
    if (!pdftotextBin) {
        return undefined;
    }
    const rangeArgs = [
        firstPage !== undefined ? `-f ${firstPage}` : '',
        lastPage !== undefined ? `-l ${lastPage}` : ''
    ].filter(Boolean).join(' ');
    const textResult = await executeShellCommand(
        terminal,
        `${shellSingleQuote(pdftotextBin)}${rangeArgs ? ` ${rangeArgs}` : ''} ${shellSingleQuote(fileUri.fsPath)} -`,
        cwd,
        Math.min(20000, budgetLeft())
    ).catch(() => ({ output: '', exitCode: 1 }));
    if (textResult.exitCode !== 0 || !textResult.output.trim()) {
        return undefined;
    }
    const pages = splitPages(textResult.output);
    const firstPageNum = firstPage ?? 1;
    const goodPages = pages.filter(p => p.trim().length >= DEFAULT_MIN_CHARS_PER_PAGE);
    if (goodPages.length * 2 < pages.length) {
        return undefined;
    }
    const scannedPages: number[] = [];
    const combined = pages
        .map((text, i) => {
            const pageNum = firstPageNum + i;
            if (text.trim().length >= DEFAULT_MIN_CHARS_PER_PAGE) {
                return `--- Page ${pageNum} (text layer) ---\n${text.replace(/\n+$/, '')}`;
            }
            scannedPages.push(pageNum);
            return `--- Page ${pageNum} (no text layer) ---\n[Page ${pageNum}: scanned, no usable text layer — render_pdf_pages_code (vision) or ocr_pdf_code(engine="tesseract", firstPage=${pageNum}, lastPage=${pageNum})]`;
        })
        .join('\n\n');
    const scannedNote = scannedPages.length > 0
        ? ` ${scannedPages.length} page(s) had no usable text layer and are marked below.`
        : '';
    const header = `Text layer found — ${pages.length} page(s) read directly with pdftotext, no OCR needed (${combined.length} characters).${scannedNote}`;
    return finalizeOcrText({
        combined,
        header,
        outputPath,
        append,
        workspace,
        meta: `${path.basename(fileUri.fsPath)} pages ${firstPageNum}-${firstPageNum + pages.length - 1}`
    });
}
async function finalizeOcrText(options: {
    combined: string;
    header: string;
    tailNote?: string;
    outputPath: string | undefined;
    append: boolean;
    workspace: string | undefined;
    meta: string;
}): Promise<CallToolResult> {
    const { combined, header, tailNote = '', outputPath, append, workspace, meta } = options;
    let savedNote = '';
    if (outputPath) {
        const outUri = resolveInputPath(outputPath, workspace);
        let finalContent = combined;
        if (append) {
            const existing = await vscode.workspace.fs.readFile(outUri).then(b => Buffer.from(b).toString('utf-8'), () => undefined);
            if (existing !== undefined) {
                finalContent = existing.replace(/\n+$/, '') + '\n\n' + combined;
            }
        }
        await vscode.workspace.fs.writeFile(outUri, Buffer.from(finalContent, 'utf-8'));
        savedNote = append ? `\n\nAppended to "${outputPath}" (now ${finalContent.length} characters total).` : `\n\nFull text saved to "${outputPath}".`;
    }
    const ocrCompaction = compactOcrText(combined);
    let previewSource = combined;
    let compactNotice = '';
    if (ocrCompaction.strategy !== 'skipped' || combined.length > DEFAULT_MAX_INLINE_CHARS) {
        const handle = rememberOriginal('ocr', combined, meta);
        if (ocrCompaction.strategy !== 'skipped') {
            previewSource = ocrCompaction.text;
            compactNotice = `\n\n${formatCompactionNotice(ocrCompaction, handle)}`;
        }
        else {
            previewSource = combined.slice(0, DEFAULT_MAX_INLINE_CHARS);
            compactNotice = `\n\n[@vscode-mcp: preview truncated at ${DEFAULT_MAX_INLINE_CHARS} chars. Full original available: retrieve_output_code "${handle}"]`;
        }
    }
    const preview = previewSource.length > DEFAULT_MAX_INLINE_CHARS
        ? previewSource.slice(0, DEFAULT_MAX_INLINE_CHARS) + `\n\n[…truncated, ${previewSource.length - DEFAULT_MAX_INLINE_CHARS} more characters${outputPath ? ' — see saved file' : ''}]`
        : previewSource;
    return {
        content: [{
                type: 'text' as const,
                text: `${header}${savedNote}${tailNote}\n\n${preview}${compactNotice}`
            }]
    };
}
type PageCountSource = 'pdfinfo' | 'missing' | 'out-of-budget';

function renderSummary(fileName: string, firstPage: number, lastPage: number, dpi: number, totalPages: number | undefined, source: PageCountSource): string {
    const range = firstPage === lastPage ? `${firstPage}` : `${firstPage}–${lastPage}`;
    const readHint = 'The images are attached to this reply: look at them here, including any handwriting or faint text. They are already in this reply, so do not re-read them from disk.';
    const moreHint = 'Call again with a different firstPage/lastPage range to read the rest.';
    if (totalPages === undefined) {
        const why = source === 'out-of-budget'
            ? 'the time budget ran out before the page count could be read, not because any tool is missing'
            : 'pdfinfo is not installed, so install poppler-utils to get it';
        return `Page${firstPage === lastPage ? '' : 's'} ${range} rendered from "${fileName}" (${dpi} DPI) — total page count unknown: ${why}. So do not assume this is the whole document. ${moreHint} ${readHint}`;
    }
    if (firstPage === 1 && lastPage === totalPages) {
        return `All ${totalPages} page(s) of "${fileName}" rendered (${dpi} DPI) — this is the whole document. ${readHint}`;
    }
    const remaining = totalPages - (lastPage - firstPage + 1);
    const label = firstPage === lastPage ? 'Page' : 'Pages';
    if (remaining <= 0) {
        return `${label} ${range} of ${totalPages} rendered from "${fileName}" (${dpi} DPI) — this is the end of the document. ${readHint}`;
    }
    return `${label} ${range} of ${totalPages} rendered from "${fileName}" (${dpi} DPI) — ${remaining} page(s) of this document were not rendered. ${moreHint} ${readHint}`;
}
export function registerOcrTools(server: McpServer): void {
    server.tool('pdf_needs_ocr_code', `Decides whether a PDF needs OCR, without running it.

WHEN TO USE: before ocr_pdf_code, so you do not pay for OCR on a PDF that already has a text layer. Returns a per-page verdict plus the page ranges that actually need OCR.

If most pages report text, ocr_pdf_code(engine="auto") returns that text directly — faster and lossless.`, {
        pdfPath: z.string().describe('Path to the PDF to inspect'),
        minCharsPerPage: z.number().optional().default(DEFAULT_MIN_CHARS_PER_PAGE).describe(`A page with fewer extracted characters than this is considered "likely scanned". Defaults to ${DEFAULT_MIN_CHARS_PER_PAGE}.`),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ pdfPath, minCharsPerPage = DEFAULT_MIN_CHARS_PER_PAGE, workspace }) => {
        try {
            const fileUri = resolveInputPath(pdfPath, workspace);
            const stat = await Promise.resolve(vscode.workspace.fs.stat(fileUri)).catch(() => undefined);
            if (!stat) {
                return { content: [{ type: 'text' as const, text: `File not found: "${pdfPath}".` }], isError: true };
            }
            const terminal = getOcrTerminal();
            const cwd = path.dirname(fileUri.fsPath);
            const needsOcrDeadline = Date.now() + CLIENT_BUDGET_MS;
            const needsOcrLeft = () => needsOcrDeadline - Date.now();
            const pdftotextBin = await resolveBinary(terminal, cwd, 'pdftotext', Math.min(5000, Math.max(750, needsOcrLeft())));
            if (!pdftotextBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftotext', POPPLER_HINT) }], isError: true };
            }
            let totalPages: number | undefined;
            const pdfinfoBin = await resolveBinary(terminal, cwd, 'pdfinfo', Math.min(5000, Math.max(750, needsOcrLeft())));
            if (pdfinfoBin && needsOcrLeft() > 2000) {
                const infoResult = await executeShellCommand(terminal, `${shellSingleQuote(pdfinfoBin)} ${shellSingleQuote(fileUri.fsPath)}`, cwd, Math.min(8000, needsOcrLeft()));
                const pagesMatch = infoResult.output.match(/^Pages:\s*(\d+)/m);
                totalPages = pagesMatch ? parseInt(pagesMatch[1], 10) : undefined;
            }
            const textResult = await executeShellCommand(terminal, `${shellSingleQuote(pdftotextBin)} ${shellSingleQuote(fileUri.fsPath)} -`, cwd, Math.min(20000, Math.max(1000, needsOcrLeft())));
            if (textResult.exitCode !== 0) {
                return { content: [{ type: 'text' as const, text: `pdftotext failed:\n${textResult.output}` }], isError: true };
            }
            const pages = splitPages(textResult.output);
            const perPageCounts = pages.map(p => p.trim().length);
            const scannedPages = perPageCounts
                .map((count, i) => ({ page: i + 1, count }))
                .filter(p => p.count < minCharsPerPage);
            const totalChars = perPageCounts.reduce((a, b) => a + b, 0);
            const pageCount = totalPages ?? pages.length;
            const verdict = scannedPages.length === 0
                ? '✅ TEXTE EXTRACTIBLE — pas besoin d\'OCR.'
                : scannedPages.length === pageCount
                    ? '📷 ENTIÈREMENT SCANNÉ — OCR nécessaire pour tout le document (voir render_pdf_pages_code ou ocr_pdf_code).'
                    : `📄 MIXTE — ${scannedPages.length}/${pageCount} page(s) semblent scannées, le reste a du texte extractible.`;
            const detail = scannedPages.length > 0 && scannedPages.length < pageCount
                ? `\nPages scannées probables : ${scannedPages.map(p => p.page).join(', ')}`
                : '';
            const runtimeHint = totalChars > 0 && scannedPages.length < pageCount
                ? `\n\n➡️ Lire ce texte sans OCR : ocr_pdf_code(engine="auto") sur ce PDF le renvoie directement (ou pdftotext en shell).`
                : '';
            return {
                content: [{
                        type: 'text' as const,
                        text: `${verdict}${detail}\n\nPages : ${pageCount} — caractères extraits au total : ${totalChars}${pdfinfoBin ? '' : ' (page count estimated from pdftotext page breaks — pdfinfo not found, count may be slightly off for unusual PDFs)'}${runtimeHint}`
                    }]
            };
        }
        catch (error) {
            console.error('[pdf_needs_ocr_code] Error:', error);
            throw error;
        }
    });
    server.tool('render_pdf_pages_code', `Rasterizes PDF pages to images and returns them directly in the tool result, so whichever vision-capable model is driving this conversation can read them itself.

WHEN TO USE: Usually the best first option for handwriting, faint scans, or anything Tesseract garbles — better than ocr_pdf_code's Tesseract engine, because the calling model looks at the actual page instead of trusting a fixed-vocabulary OCR engine. No setup needed: it only rasterizes and returns images, the reading happens in the calling model. Entirely local — this tool makes no network calls itself.

Returns at most ${MAX_RENDER_PAGES} pages per call — each rendered image can be several hundred KB to a few MB. Call again with a different firstPage/lastPage range for more pages.`, {
        pdfPath: z.string().describe('Path to the PDF'),
        firstPage: z.number().optional().default(1).describe('First page to render (1-indexed). Defaults to 1.'),
        lastPage: z.number().optional().describe('Last page to render (1-indexed, inclusive). Defaults to firstPage (a single page) if omitted.'),
        dpi: z.number().optional().default(DEFAULT_RENDER_DPI).describe(`Rasterization resolution. Higher is sharper but slower.`),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ pdfPath, firstPage = 1, lastPage, dpi = DEFAULT_RENDER_DPI, workspace }): Promise<CallToolResult> => {
        let tmpDir: string | undefined;
        try {
            const fileUri = resolveInputPath(pdfPath, workspace);
            const stat = await Promise.resolve(vscode.workspace.fs.stat(fileUri)).catch(() => undefined);
            if (!stat) {
                return { content: [{ type: 'text' as const, text: `File not found: "${pdfPath}".` }], isError: true };
            }
            const effectiveLast = lastPage ?? firstPage;
            if (effectiveLast < firstPage) {
                return { content: [{ type: 'text' as const, text: 'lastPage must be greater than or equal to firstPage.' }], isError: true };
            }
            if (effectiveLast - firstPage + 1 > MAX_RENDER_PAGES) {
                return { content: [{ type: 'text' as const, text: `Requested ${effectiveLast - firstPage + 1} pages, but this tool returns at most ${MAX_RENDER_PAGES} per call — narrow the range and call again for the rest.` }], isError: true };
            }
            const terminal = getOcrTerminal();
            const cwd = path.dirname(fileUri.fsPath);
            const startedAt = Date.now();
            const remainingBudget = (): number => CLIENT_BUDGET_MS - (Date.now() - startedAt);
            const bounded = (cap: number): number => Math.max(750, Math.min(cap, remainingBudget()));
            let totalPages: number | undefined;
            let pageCountSource: PageCountSource = 'missing';
            if (remainingBudget() < MIN_METADATA_BUDGET_MS) {
                pageCountSource = 'out-of-budget';
            }
            else {
                const pdfinfoBin = await resolveBinary(terminal, cwd, 'pdfinfo', bounded(5000));
                if (pdfinfoBin && remainingBudget() >= MIN_METADATA_BUDGET_MS) {
                    const infoTimeout = Math.max(500, Math.min(PDFINFO_TIMEOUT_MS, remainingBudget() - MIN_METADATA_BUDGET_MS / 2));
                    const infoResult = await executeShellCommand(terminal, `${shellSingleQuote(pdfinfoBin)} ${shellSingleQuote(fileUri.fsPath)}`, cwd, infoTimeout).catch(() => ({ output: '', exitCode: 1 }));
                    const pagesMatch = infoResult.output.match(/^Pages:\s*(\d+)/m);
                    const parsed = pagesMatch ? parseInt(pagesMatch[1], 10) : NaN;
                    if (Number.isFinite(parsed) && parsed > 0) {
                        totalPages = parsed;
                        pageCountSource = 'pdfinfo';
                    }
                }
                else if (pdfinfoBin) {
                    pageCountSource = 'out-of-budget';
                }
            }
            const pdftoppmBin = await resolveBinary(terminal, cwd, 'pdftoppm', bounded(5000));
            if (!pdftoppmBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftoppm', POPPLER_HINT) }], isError: true };
            }
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-render-'));
            const pagePrefix = path.join(tmpDir, 'page');
            const rasterCmd = `${shellSingleQuote(pdftoppmBin)} -r ${dpi} -png -f ${firstPage} -l ${effectiveLast} ${shellSingleQuote(fileUri.fsPath)} ${shellSingleQuote(pagePrefix)}`;
            const rasterResult = await executeShellCommand(terminal, rasterCmd, cwd, Math.min(60000, remainingBudget()));
            const images = fs.readdirSync(tmpDir)
                .filter(f => f.startsWith('page') && f.endsWith('.png'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (images.length === 0) {
                const detail = rasterResult.exitCode !== 0
                    ? `pdftoppm failed:\n${rasterResult.output}`
                    : 'pdftoppm produced no page images — check the page range is within the document.';
                return { content: [{ type: 'text' as const, text: detail }], isError: true };
            }
            const summary = renderSummary(path.basename(fileUri.fsPath), firstPage, effectiveLast, dpi, totalPages, pageCountSource);
            const lateFinish = rasterResult.exitCode === 124
                ? ' The shell call hit its deadline, but pdftoppm had already written these pages, so they are complete.'
                : '';
            const content: CallToolResult['content'] = [
                { type: 'text', text: summary + lateFinish }
            ];
            images.forEach((image, i) => {
                const bytes = fs.readFileSync(path.join(tmpDir!, image));
                content.push({ type: 'text', text: `Page ${firstPage + i}:` });
                content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
            });
            return { content };
        }
        catch (error) {
            console.error('[render_pdf_pages_code] Error:', error);
            throw error;
        }
        finally {
            if (tmpDir) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }
    });
    server.tool('ocr_pdf_code', `OCR on a scanned/image-only PDF.

WHEN TO USE: "tesseract" for PDFs pdf_needs_ocr_code flagged as scanned — on a text-layer PDF it is slower and lossier. "auto" is safe on any PDF: it returns the existing text layer verbatim when most pages have one.

PAGE CAPS: the client enforces a ~30s ceiling that timeoutMs cannot extend. One call caps at ${MAX_PAGES_PER_CALL.tesseract} pages ("tesseract"), ${MAX_PAGES_PER_CALL.auto} ("auto"), ${MAX_PAGES_PER_CALL.vision} ("vision"); longer work = repeated calls over small ranges with the same outputPath and append:true.

ENGINES:
- "tesseract" (default): fast, weak on handwriting and faint scans.
- "vision": local Ollama transcription (slow, nothing leaves the machine). Prefer render_pdf_pages_code to read the pages yourself.
- "auto": text layer first, else tesseract, then vision escalation for low-confidence pages.

Output is compacted; a retrieve_output_code handle in the notice gives the full text when no outputPath was set.`, {
        pdfPath: z.string().describe('Path to the scanned PDF'),
        engine: z.enum(['tesseract', 'vision', 'auto']).optional().default('tesseract').describe('OCR engine — see the description for trade-offs.'),
        language: z.string().optional().default('eng').describe('Tesseract language code or "+"-joined combo, e.g. "fra+eng".'),
        firstPage: z.number().optional().describe('First page to OCR (1-indexed). Omit to start at page 1.'),
        lastPage: z.number().optional().describe('Last page (1-indexed, inclusive). The per-engine page cap still applies.'),
        dpi: z.number().optional().default(DEFAULT_DPI).describe('Rasterization resolution. 150 speeds up the vision engines.'),
        ollamaUrl: z.string().optional().default(DEFAULT_OLLAMA_URL).describe(`Base URL of the local Ollama server, used by the "vision"/"auto" engines. Defaults to "${DEFAULT_OLLAMA_URL}".`),
        visionModel: z.string().optional().default(DEFAULT_OLLAMA_VISION_MODEL).describe('Ollama vision model, must already be pulled locally.'),
        visionConfidenceThreshold: z.number().optional().default(DEFAULT_VISION_CONFIDENCE_THRESHOLD).describe('Engine "auto" only: Tesseract confidence (0-100) below which a page is retried with vision.'),
        outputPath: z.string().optional().describe('Save the extracted text to this .txt path. Recommended for multi-page runs.'),
        append: z.boolean().optional().default(false).describe('With outputPath: append instead of overwriting, to accumulate several calls into one file.'),
        timeoutMs: z.number().optional().default(DEFAULT_OCR_TIMEOUT_MS).describe('Internal processing budget in ms; the client ceiling still applies.'),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ pdfPath, engine = 'tesseract', language = 'eng', firstPage, lastPage, dpi = DEFAULT_DPI, ollamaUrl = DEFAULT_OLLAMA_URL, visionModel = DEFAULT_OLLAMA_VISION_MODEL, visionConfidenceThreshold = DEFAULT_VISION_CONFIDENCE_THRESHOLD, outputPath, append = false, timeoutMs = DEFAULT_OCR_TIMEOUT_MS, workspace }) => {
        let tmpDir: string | undefined;
        const deadline = Date.now() + Math.min(timeoutMs, CLIENT_BUDGET_MS);
        const budgetLeft = () => deadline - Date.now();
        try {
            const fileUri = resolveInputPath(pdfPath, workspace);
            const stat = await Promise.resolve(vscode.workspace.fs.stat(fileUri)).catch(() => undefined);
            if (!stat) {
                return { content: [{ type: 'text' as const, text: `File not found: "${pdfPath}".` }], isError: true };
            }
            if (engine === 'auto') {
                const textLayer = await tryTextLayer({ fileUri, firstPage, lastPage, budgetLeft, outputPath, append, workspace });
                if (textLayer) {
                    return textLayer;
                }
            }
            if (firstPage && lastPage) {
                const requested = lastPage - firstPage + 1;
                const cap = MAX_PAGES_PER_CALL[engine];
                if (requested > cap) {
                    return {
                        content: [{
                                type: 'text' as const,
                                text: `Requested ${requested} pages (${firstPage}-${lastPage}) for engine "${engine}", but a single call is capped at ${cap} for this engine to stay under the calling client's ~30s per-call ceiling. Split into multiple calls of up to ${cap} pages each — pass the same outputPath with append:true to accumulate them into one file, in page order.`
                            }],
                        isError: true
                    };
                }
            }
            let visionReady = false;
            let visionUnavailableReason = '';
            if (engine === 'vision' || engine === 'auto') {


                await assertUrlSafe(ollamaUrl, { allowLoopback: true, allowPrivateNetwork: true });
                const check = await checkOllamaModel(ollamaUrl, visionModel);
                visionReady = check.ok;
                visionUnavailableReason = check.reason || '';
                if (engine === 'vision' && !visionReady) {
                    return {
                        content: [{
                                type: 'text' as const,
                                text: `${visionUnavailableReason} Alternatively, use render_pdf_pages_code to have the calling model read the pages itself with zero local setup.`
                            }],
                        isError: true
                    };
                }
            }
            const terminal = getOcrTerminal();
            const cwd = path.dirname(fileUri.fsPath);
            const pdftoppmBin = await resolveBinary(terminal, cwd, 'pdftoppm', Math.min(5000, Math.max(750, budgetLeft())));
            if (!pdftoppmBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftoppm', 'poppler-utils (e.g. "apt install poppler-utils" / "winget install oschwartz10612.Poppler")') }], isError: true };
            }
            let tesseractBin: string | undefined;
            if (engine !== 'vision') {
                tesseractBin = await resolveBinary(terminal, cwd, 'tesseract', Math.min(5000, Math.max(750, budgetLeft())));
                if (!tesseractBin) {
                    return {
                        content: [{ type: 'text' as const, text: missingBinaryMessage('tesseract', `tesseract-ocr (e.g. "apt install tesseract-ocr tesseract-ocr-${language.split('+')[0]}" / "winget install UB-Mannheim.TesseractOCR")`) }],
                        isError: true
                    };
                }
            }
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ocr-'));
            const pagePrefix = path.join(tmpDir, 'page');
            let rasterCmd = `${shellSingleQuote(pdftoppmBin)} -r ${dpi} -png`;
            if (firstPage) {
                rasterCmd += ` -f ${firstPage}`;
            }
            if (lastPage) {
                rasterCmd += ` -l ${lastPage}`;
            }
            rasterCmd += ` ${shellSingleQuote(fileUri.fsPath)} ${shellSingleQuote(pagePrefix)}`;
            const rasterResult = await executeShellCommand(terminal, rasterCmd, cwd, Math.max(1000, Math.min(timeoutMs, 60000, budgetLeft())));
            if (rasterResult.exitCode !== 0 && rasterResult.exitCode !== 124) {
                return { content: [{ type: 'text' as const, text: `pdftoppm failed:\n${rasterResult.output}` }], isError: true };
            }
            const images = fs.readdirSync(tmpDir)
                .filter(f => f.startsWith('page') && f.endsWith('.png'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (images.length === 0) {
                const why = rasterResult.exitCode === 124
                    ? `pdftoppm hit this call's time budget before writing a single page image at ${dpi} DPI — retry with a narrower page range or dpi=150.`
                    : 'pdftoppm produced no page images — check firstPage/lastPage are within range.';
                return { content: [{ type: 'text' as const, text: why }], isError: true };
            }
            const engineCap = MAX_PAGES_PER_CALL[engine];
            if (images.length > engineCap) {
                return {
                    content: [{
                            type: 'text' as const,
                            text: `This range covers ${images.length} pages, but a single call is capped at ${engineCap} for engine "${engine}" to stay under the calling client's ~30s per-call ceiling. Pass firstPage/lastPage to split it into calls of up to ${engineCap} pages each — pass the same outputPath with append:true to accumulate them into one file, in page order.`
                        }],
                    isError: true
                };
            }
            const perPageTimeout = Math.max(15000, Math.floor(timeoutMs / images.length));
            const visionPageTimeout = Math.max(12000, Math.min(20000, Math.floor(timeoutMs / Math.ceil(images.length / 2))));
            const skippedNote = (pageNum: number) => `[Skipped: this call's internal budget ran out before this page — call ocr_pdf_code again with firstPage=${pageNum} lastPage=${pageNum}]`;
            const pageResults: Array<{ pageNum: number; text: string; engineUsed: string }> = [];
            const escalations: Array<{ index: number; pageNum: number; imgPath: string }> = [];
            if (engine !== 'vision') {
                for (let i = 0; i < images.length; i++) {
                    const imgPath = path.join(tmpDir, images[i]);
                    const pageNum = (firstPage ?? 1) + i;
                    const remaining = budgetLeft();
                    if (remaining < 4000) {
                        pageResults.push({ pageNum, text: skippedNote(pageNum), engineUsed: 'skipped' });
                        continue;
                    }
                    const tsvResult = await executeShellCommand(terminal, `${shellSingleQuote(tesseractBin!)} ${shellSingleQuote(imgPath)} stdout -l ${shellSingleQuote(language)} tsv`, tmpDir, Math.min(perPageTimeout, remaining));
                    if (tsvResult.exitCode !== 0) {
                        pageResults.push({ pageNum, text: `[Tesseract failed: ${tsvResult.output.trim().slice(0, 300)}]`, engineUsed: 'tesseract' });
                        continue;
                    }
                    const parsed = parseTsv(tsvResult.output);
                    let text = parsed.text;
                    let engineUsed = 'tesseract';
                    const looksBad = parsed.confidence < visionConfidenceThreshold || parsed.text.trim().length < 5;
                    if (engine === 'auto' && looksBad) {
                        if (visionReady) {
                            escalations.push({ index: pageResults.length, pageNum, imgPath });
                        }
                        else {
                            text += `\n[Low-confidence Tesseract result (${parsed.confidence.toFixed(0)}%) — ${visionUnavailableReason || 'local vision fallback unavailable'}]`;
                        }
                    }
                    pageResults.push({ pageNum, text, engineUsed });
                }
            }
            const visionTasks: Array<() => Promise<void>> = [];
            if (engine === 'vision') {
                for (let i = 0; i < images.length; i++) {
                    const imgPath = path.join(tmpDir, images[i]);
                    const pageNum = (firstPage ?? 1) + i;
                    const idx = pageResults.length;
                    pageResults.push({ pageNum, text: '', engineUsed: 'vision' });
                    visionTasks.push(async () => {
                        const remaining = budgetLeft();
                        if (remaining < 4000) {
                            pageResults[idx] = { pageNum, text: skippedNote(pageNum), engineUsed: 'skipped' };
                            return;
                        }
                        try {
                            const imgB64 = fs.readFileSync(imgPath).toString('base64');
                            const text = await callLocalVisionOcr(ollamaUrl, visionModel, imgB64, language, Math.min(visionPageTimeout, remaining));
                            pageResults[idx] = { pageNum, text, engineUsed: 'vision' };
                        }
                        catch (e: any) {
                            pageResults[idx] = { pageNum, text: `[Vision OCR failed: ${e.message}]`, engineUsed: 'vision' };
                        }
                    });
                }
            }
            if (escalations.length > 0) {
                for (const esc of escalations) {
                    visionTasks.push(async () => {
                        const remaining = budgetLeft();
                        if (remaining < 4000) {
                            pageResults[esc.index] = { pageNum: esc.pageNum, text: skippedNote(esc.pageNum), engineUsed: 'skipped' };
                            return;
                        }
                        try {
                            const imgB64 = fs.readFileSync(esc.imgPath).toString('base64');
                            const text = await callLocalVisionOcr(ollamaUrl, visionModel, imgB64, language, Math.min(visionPageTimeout, remaining));
                            pageResults[esc.index] = { pageNum: esc.pageNum, text, engineUsed: 'vision' };
                        }
                        catch (e: any) {
                            pageResults[esc.index] = { pageNum: esc.pageNum, text: `${pageResults[esc.index].text}\n[Vision fallback failed: ${e.message}]`, engineUsed: 'tesseract' };
                        }
                    });
                }
            }
            if (visionTasks.length > 0) {
                await runPool(visionTasks, 2);
            }
            const skippedCount = pageResults.filter(p => p.engineUsed === 'skipped').length;
            const skipFooter = skippedCount > 0
                ? `\n\n⚠️ ${skippedCount} page(s) were skipped because this call's time budget ran out before they could be processed — each is marked [Skipped …] with its page number. Continue OCR by re-running ocr_pdf_code with firstPage/lastPage on just those pages.`
                : '';
            const rasterFooter = rasterResult.exitCode === 124
                ? `\n\n⚠️ pdftoppm hit this call's time budget, so only the pages above were rasterized — continue OCR with a later firstPage.`
                : '';
            const combined = pageResults
                .map(p => `--- Page ${p.pageNum} (${p.engineUsed}) ---\n${p.text}`)
                .join('\n\n');
            const visionCount = pageResults.filter(p => p.engineUsed === 'vision').length;
            const engineNote = engine === 'auto' && visionCount > 0 ? ` (${visionCount} page(s) escalated to local vision)` : '';
            return finalizeOcrText({
                combined,
                header: `OCR done — ${images.length} page(s)${engineNote}, ${combined.length} characters total.`,
                tailNote: skipFooter + rasterFooter,
                outputPath,
                append,
                workspace,
                meta: `${path.basename(fileUri.fsPath)} pages ${firstPage ?? 1}-${(firstPage ?? 1) + images.length - 1}`
            });
        }
        catch (error) {
            console.error('[ocr_pdf_code] Error:', error);
            throw error;
        }
        finally {
            if (tmpDir) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }
    });
}
