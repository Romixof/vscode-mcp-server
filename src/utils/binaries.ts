import * as fs from 'fs';
import { execFile } from 'child_process';

export const POPPLER_HINT = 'poppler-utils (e.g. "apt install poppler-utils" / "brew install poppler" / "winget install oschwartz10612.Poppler")';
export const TESSERACT_HINT = 'tesseract-ocr (e.g. "apt install tesseract-ocr tesseract-ocr-eng" / "winget install UB-Mannheim.TesseractOCR")';
export const GIT_BASH_HINT = 'Git for Windows (e.g. "winget install Git.Git") — the shell tools run commands through its bash';

function winToBashPath(value: string): string {
        return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_: string, d: string) => `/${d.toLowerCase()}`);
}

export const WINDOWS_FALLBACK_DIRS: Record<string, string[]> = {
        tesseract: [
                '/c/Program Files/Tesseract-OCR',
                '/c/Program Files (x86)/Tesseract-OCR',
                ...(process.env.LocalAppData ? [`${winToBashPath(process.env.LocalAppData)}/Programs/Tesseract-OCR`] : [])
        ]
};

const GIT_BASH_CANDIDATES = process.platform === 'win32' ? [
        `${process.env.ProgramFiles || 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        `${process.env.LocalAppData || ''}\\Programs\\Git\\bin\\bash.exe`
].filter(p => p.length > 0 && !p.startsWith('\\')) : [];

export function findGitBash(): string | undefined {
        for (const candidate of GIT_BASH_CANDIDATES) {
                try {
                        if (fs.existsSync(candidate)) {
                                return candidate;
                        }
                }
                catch {
                }
        }
        return undefined;
}

export interface BinaryStatus {
        name: string;
        found: boolean;
        path?: string;
        hint?: string;
}

const PROBE_TIMEOUT_MS = 1500;

export function probeBinary(name: string, hint: string, platform: NodeJS.Platform = process.platform): Promise<BinaryStatus> {
        return new Promise<BinaryStatus>(resolve => {
                const [cmd, args] = platform === 'win32'
                        ? ['where.exe', [name]]
                        : ['sh', ['-c', `command -v ${name}`]];
                execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
                        const first = !error && stdout ? String(stdout).trim().split(/\r?\n/)[0]?.trim() : undefined;
                        if (first) {
                                resolve({ name, found: true, path: first });
                                return;
                        }
                        for (const dir of platform === 'win32' ? (WINDOWS_FALLBACK_DIRS[name] ?? []) : []) {
                                const exePath = `${dir}/${name}.exe`;
                                if (fs.existsSync(exePath)) {
                                        resolve({ name, found: true, path: exePath });
                                        return;
                                }
                        }
                        resolve({ name, found: false, hint });
                });
        });
}

const PDF_BINARIES: Array<{ name: string; hint: string }> = [
        { name: 'pdftotext', hint: POPPLER_HINT },
        { name: 'pdfinfo', hint: POPPLER_HINT },
        { name: 'pdftoppm', hint: POPPLER_HINT },
        { name: 'tesseract', hint: TESSERACT_HINT }
];

export async function probePdfBinaries(): Promise<BinaryStatus[]> {
        const pdf = await Promise.all(PDF_BINARIES.map(b => probeBinary(b.name, b.hint)));
        const bash = findGitBash();
        const bashStatus: BinaryStatus = bash
                ? { name: 'bash (Git Bash)', found: true, path: bash }
                : { name: 'bash (Git Bash)', found: false, hint: GIT_BASH_HINT };
        return [...pdf, bashStatus];
}