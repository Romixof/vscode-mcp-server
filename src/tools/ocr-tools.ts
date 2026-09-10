import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { executeShellCommand } from './shell-tools';
import { compactOcrText, rememberOriginal, formatCompactionNotice } from '../utils/token-efficiency';

const DEFAULT_MIN_CHARS_PER_PAGE = 20;
const DEFAULT_DPI = 300;
const DEFAULT_RENDER_DPI = 200;
const DEFAULT_MAX_INLINE_CHARS = 20000;
const MAX_RENDER_PAGES = 8;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_VISION_MODEL = 'llama3.2-vision';
const DEFAULT_VISION_CONFIDENCE_THRESHOLD = 70;
const MAX_PAGES_PER_CALL = {
    tesseract: 15, // fast, local, no inference — a full shell round-trip per page is the only cost
    auto: 6, // mostly Tesseract-fast, but an unknown number of pages may escalate to vision
    vision: 3
};
const DEFAULT_OCR_TIMEOUT_MS = 25000;
function winToBashPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_: string, d: string) => `/${d.toLowerCase()}`);
}
const WINDOWS_FALLBACK_DIRS: Record<string, string[]> = {
    tesseract: [
        '/c/Program Files/Tesseract-OCR',
        '/c/Program Files (x86)/Tesseract-OCR',
        ...(process.env.LocalAppData ? [`${winToBashPath(process.env.LocalAppData)}/Programs/Tesseract-OCR`] : [])
    ]
};
function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
const OCR_TERMINAL_NAME = 'MCP OCR';
const GIT_BASH_CANDIDATES = process.platform === 'win32' ? [
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LocalAppData || ''}\\Programs\\Git\\bin\\bash.exe`
].filter(p => p.length > 0 && !p.startsWith('\\')) : [];
function findGitBash(): string | undefined {
    for (const candidate of GIT_BASH_CANDIDATES) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        catch { /* ignore */ }
    }
    return undefined;
}
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
async function resolveBinary(terminal: vscode.Terminal, cwd: string, bin: string): Promise<string | undefined> {
    const check = await executeShellCommand(terminal, `command -v ${bin}`, cwd, 5000).catch(() => ({ output: '', exitCode: 1 }));
    if (check.exitCode === 0) {
        return bin;
    }
    const winCheck = await executeShellCommand(terminal, `where.exe ${bin}`, cwd, 5000).catch(() => ({ output: '', exitCode: 1 }));
    if (winCheck.exitCode === 0) {
        return bin;
    }
    for (const dir of WINDOWS_FALLBACK_DIRS[bin] || []) {
        const exePath = `${dir}/${bin}.exe`;
        const probe = await executeShellCommand(terminal, `test -f ${shellSingleQuote(exePath)}`, cwd, 5000).catch(() => ({ output: '', exitCode: 1 }));
        if (probe.exitCode === 0) {
            return exePath;
        }
    }
    return undefined;
}
function missingBinaryMessage(bin: string, installHint: string): string {
    const fallbackNote = WINDOWS_FALLBACK_DIRS[bin]
        ? ` Also checked the usual Windows install location(s) (${WINDOWS_FALLBACK_DIRS[bin].join(', ')}) and found nothing there either — if you just installed it, verify the install actually completed (reinstall if needed), or check "Add to PATH" was enabled during setup.`
        : '';
    return `"${bin}" is not available on PATH — install ${installHint}.${fallbackNote} `
        + 'If you just installed it and this still fails, fully quit and relaunch VS Code (not just the terminal) — '
        + 'a PATH change made by an installer is not visible to a process, like VS Code, that was already running when it happened.';
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
export function registerOcrTools(server: McpServer): void {
    server.tool('pdf_needs_ocr_code', `Checks whether a PDF already has extractable text or is (fully or partially) a scanned/image-only document that would need OCR — without running OCR itself.

WHEN TO USE: Before deciding to OCR a PDF, or before feeding a PDF into a text-extraction pipeline (e.g. summarizing a scanned course handout). Scanned pages report ~0 characters from a plain text extraction even though they clearly have content, so this catches that case up front instead of the caller silently getting an empty/garbled result. Also useful for mixed documents (e.g. a mostly-typed report with one scanned signature page) — reports which specific pages look scanned.

Requires "pdftotext" (poppler-utils) on PATH — that's the only hard dependency. "pdfinfo" is used opportunistically for an authoritative page count when it's also available, but its absence never blocks the check (page count then falls back to counting page breaks in pdftotext's own output). Entirely local — no network calls.`, {
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
            const pdftotextBin = await resolveBinary(terminal, cwd, 'pdftotext');
            if (!pdftotextBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftotext', 'poppler-utils (e.g. "apt install poppler-utils" / "brew install poppler" / "winget install oschwartz10612.Poppler")') }], isError: true };
            }
            let totalPages: number | undefined;
            const pdfinfoBin = await resolveBinary(terminal, cwd, 'pdfinfo');
            if (pdfinfoBin) {
                const infoResult = await executeShellCommand(terminal, `${shellSingleQuote(pdfinfoBin)} ${shellSingleQuote(fileUri.fsPath)}`, cwd, 8000);
                const pagesMatch = infoResult.output.match(/^Pages:\s*(\d+)/m);
                totalPages = pagesMatch ? parseInt(pagesMatch[1], 10) : undefined;
            }
            const textResult = await executeShellCommand(terminal, `${shellSingleQuote(pdftotextBin)} ${shellSingleQuote(fileUri.fsPath)} -`, cwd, 20000);
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
            return {
                content: [{
                        type: 'text' as const,
                        text: `${verdict}${detail}\n\nPages : ${pageCount} — caractères extraits au total : ${totalChars}${pdfinfoBin ? '' : ' (page count estimated from pdftotext page breaks — pdfinfo not found, count may be slightly off for unusual PDFs)'}`
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
        dpi: z.number().optional().default(DEFAULT_RENDER_DPI).describe(`Rasterization resolution. ${DEFAULT_RENDER_DPI} is usually enough for a model to read comfortably; go higher (300+) only for very small or faint handwriting — larger images take longer and cost more to send.`),
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
            const pdftoppmBin = await resolveBinary(terminal, cwd, 'pdftoppm');
            if (!pdftoppmBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftoppm', 'poppler-utils (e.g. "apt install poppler-utils" / "brew install poppler" / "winget install oschwartz10612.Poppler")') }], isError: true };
            }
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-render-'));
            const pagePrefix = path.join(tmpDir, 'page');
            const rasterCmd = `${shellSingleQuote(pdftoppmBin)} -r ${dpi} -png -f ${firstPage} -l ${effectiveLast} ${shellSingleQuote(fileUri.fsPath)} ${shellSingleQuote(pagePrefix)}`;
            const rasterResult = await executeShellCommand(terminal, rasterCmd, cwd, 60000);
            if (rasterResult.exitCode !== 0) {
                return { content: [{ type: 'text' as const, text: `pdftoppm failed:\n${rasterResult.output}` }], isError: true };
            }
            const images = fs.readdirSync(tmpDir)
                .filter(f => f.startsWith('page') && f.endsWith('.png'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (images.length === 0) {
                return { content: [{ type: 'text' as const, text: 'pdftoppm produced no page images — check the page range is within the document.' }], isError: true };
            }
            const content: CallToolResult['content'] = [
                { type: 'text', text: `${images.length} page(s) rendered from "${path.basename(fileUri.fsPath)}" (pages ${firstPage}–${effectiveLast}, ${dpi} DPI). Read each image directly, including any handwriting or faint text.` }
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
    server.tool('ocr_pdf_code', `Runs OCR on a scanned/image-only PDF and returns the extracted text. Entirely local — no data ever leaves the machine, for any engine.

WHEN TO USE: After pdf_needs_ocr_code (or otherwise knowing) confirms a PDF has no extractable text layer. Do NOT run this on a PDF that already has a text layer: it's slow and lossy compared to just reading the text directly (pdftotext, or the pdf/pdf-reading skill if this environment has one).

⚠️ THE CALLING CLIENT ENFORCES ITS OWN ~30-SECOND CEILING ON A SINGLE TOOL CALL, regardless of the timeoutMs given here — raising timeoutMs only controls this tool's own internal budget, it CANNOT extend the client's limit, and a call that gets killed client-side can leave the shared OCR terminal busy for the next call. For anything beyond a couple of pages, call this tool REPEATEDLY with small page ranges (firstPage/lastPage) and outputPath+append:true to accumulate results, rather than one call over the whole document. To stay under that ceiling, a single call is capped at ${MAX_PAGES_PER_CALL.tesseract} pages for engine "tesseract", ${MAX_PAGES_PER_CALL.auto} for "auto", ${MAX_PAGES_PER_CALL.vision} for "vision" — exceeding the cap is rejected immediately (no wasted attempt) with a message to split the range.

THREE ENGINES, pick with "engine":
- "tesseract" (default): fast, lightweight — but weak on handwriting, faint scans, or unusual fonts.
- "vision": sends each page image to a LOCAL vision model served by Ollama (http://localhost:11434 by default) and asks for a verbatim transcription — much better on handwriting and poor-quality scans, but each page can take several seconds to over a minute depending on the model and hardware (CPU vs GPU). Requires Ollama installed (https://ollama.com) and a vision-capable model already pulled (e.g. "ollama pull llama3.2-vision"). Nothing is sent over the internet — it's a local HTTP call to your own machine. Prefer render_pdf_pages_code instead if you'd rather have the calling model read the pages itself with zero local setup and no per-call page cap.
- "auto": runs Tesseract first (fast, lightweight); for any page where Tesseract's own confidence falls below visionConfidenceThreshold (or it recognizes almost nothing), automatically retries that specific page with the local vision engine if Ollama and the model are available. Best default when some pages are clean print and others are handwritten/faint — but a batch where MANY pages escalate to vision can still be slow, so keep batches small.

Requires "pdftoppm" (poppler-utils) always. "tesseract" (with the requested language's trained data) is required for the "tesseract" and "auto" engines. For a big scanned document, a good pattern is: pdf_needs_ocr_code to find which pages need OCR, then one ocr_pdf_code call per small consecutive range of those pages (engine "tesseract" for clean scans, "vision" for handwriting), each with the same outputPath and append:true, in page order.

Token efficiency: the returned text is lightly compacted (blank/duplicate-line collapse) and a retrieve_output_code handle in the trailing notice always gives access to the full uncompacted text when no outputPath was set. Vision pages run 2 at a time; pages that don't fit the internal budget are returned as [Skipped …] markers (with the exact range to re-run) instead of the whole call dying at the client's ceiling.`, {
        pdfPath: z.string().describe('Path to the scanned PDF'),
        engine: z.enum(['tesseract', 'vision', 'auto']).optional().default('tesseract').describe('OCR engine — see the tool description for the trade-offs of each.'),
        language: z.string().optional().default('eng').describe('Tesseract language code (or "+"-joined combo, e.g. "fra+eng"). The matching trained-data file must be installed. Also passed to the vision engine as a hint. Defaults to "eng".'),
        firstPage: z.number().optional().describe('First page to OCR (1-indexed). Omit to start at page 1.'),
        lastPage: z.number().optional().describe('Last page to OCR (1-indexed, inclusive). Omit to go to the last page. See the per-engine page cap in the tool description — a wide, unset range on a long document will be rejected.'),
        dpi: z.number().optional().default(DEFAULT_DPI).describe(`Rasterization resolution. Higher improves accuracy on small print but is slower — for the "vision"/"auto" engines, a lower value (e.g. 150) noticeably speeds up local model inference. Defaults to ${DEFAULT_DPI}.`),
        ollamaUrl: z.string().optional().default(DEFAULT_OLLAMA_URL).describe(`Base URL of the local Ollama server, used by the "vision"/"auto" engines. Defaults to "${DEFAULT_OLLAMA_URL}".`),
        visionModel: z.string().optional().default(DEFAULT_OLLAMA_VISION_MODEL).describe(`Ollama vision model to use, must already be pulled locally ("ollama pull <model>"). Defaults to "${DEFAULT_OLLAMA_VISION_MODEL}" — other options include "qwen2.5vl", "minicpm-v", or any other vision-capable model you've pulled.`),
        visionConfidenceThreshold: z.number().optional().default(DEFAULT_VISION_CONFIDENCE_THRESHOLD).describe(`Only used by engine "auto": a page whose average Tesseract word confidence (0-100) falls below this is retried with the local vision engine. Defaults to ${DEFAULT_VISION_CONFIDENCE_THRESHOLD}.`),
        outputPath: z.string().optional().describe('If set, saves the extracted text to this .txt path (recommended for multi-page documents). The tool result always shows a preview either way.'),
        append: z.boolean().optional().default(false).describe('When outputPath is set: append to the file instead of overwriting it. Use this to accumulate results across several calls (one per small page range) into one combined file, in page order.'),
        timeoutMs: z.number().optional().default(DEFAULT_OCR_TIMEOUT_MS).describe(`Internal budget for this tool's own processing, in milliseconds. Defaults to ${DEFAULT_OCR_TIMEOUT_MS} — deliberately kept under the calling client's own ~30s per-call ceiling (see the tool description), since raising this past that ceiling has no effect and just delays a clean failure. Lower it further for a faster failure on very slow hardware.`),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ pdfPath, engine = 'tesseract', language = 'eng', firstPage, lastPage, dpi = DEFAULT_DPI, ollamaUrl = DEFAULT_OLLAMA_URL, visionModel = DEFAULT_OLLAMA_VISION_MODEL, visionConfidenceThreshold = DEFAULT_VISION_CONFIDENCE_THRESHOLD, outputPath, append = false, timeoutMs = DEFAULT_OCR_TIMEOUT_MS, workspace }) => {
        let tmpDir: string | undefined;
        try {
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
            const fileUri = resolveInputPath(pdfPath, workspace);
            const stat = await Promise.resolve(vscode.workspace.fs.stat(fileUri)).catch(() => undefined);
            if (!stat) {
                return { content: [{ type: 'text' as const, text: `File not found: "${pdfPath}".` }], isError: true };
            }
            let visionReady = false;
            let visionUnavailableReason = '';
            if (engine === 'vision' || engine === 'auto') {
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
            const pdftoppmBin = await resolveBinary(terminal, cwd, 'pdftoppm');
            if (!pdftoppmBin) {
                return { content: [{ type: 'text' as const, text: missingBinaryMessage('pdftoppm', 'poppler-utils (e.g. "apt install poppler-utils" / "winget install oschwartz10612.Poppler")') }], isError: true };
            }
            let tesseractBin: string | undefined;
            if (engine !== 'vision') {
                tesseractBin = await resolveBinary(terminal, cwd, 'tesseract');
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
            const rasterResult = await executeShellCommand(terminal, rasterCmd, cwd, Math.min(timeoutMs, 60000));
            if (rasterResult.exitCode !== 0) {
                return { content: [{ type: 'text' as const, text: `pdftoppm failed:\n${rasterResult.output}` }], isError: true };
            }
            const images = fs.readdirSync(tmpDir)
                .filter(f => f.startsWith('page') && f.endsWith('.png'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (images.length === 0) {
                return { content: [{ type: 'text' as const, text: 'pdftoppm produced no page images — check firstPage/lastPage are within range.' }], isError: true };
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
            const deadline = Date.now() + timeoutMs;
            const budgetLeft = () => deadline - Date.now();
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
                ? `\n\n⚠️ ${skippedCount} page(s) were skipped because this call's internal budget ran out before they could be processed — each is marked [Skipped …] with its page number. Re-run ocr_pdf_code for just those pages.`
                : '';
            const combined = pageResults
                .map(p => `--- Page ${p.pageNum} (${p.engineUsed}) ---\n${p.text}`)
                .join('\n\n');
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
                const meta = `${path.basename(fileUri.fsPath)} pages ${firstPage ?? 1}-${(firstPage ?? 1) + images.length - 1}`;
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
            const visionCount = pageResults.filter(p => p.engineUsed === 'vision').length;
            const engineNote = engine === 'auto' && visionCount > 0 ? ` (${visionCount} page(s) escalated to local vision)` : '';
            return {
                content: [{
                        type: 'text' as const,
                        text: `OCR done — ${images.length} page(s)${engineNote}, ${combined.length} characters total.${savedNote}${skipFooter}\n\n${preview}${compactNotice}`
                    }]
            };
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
