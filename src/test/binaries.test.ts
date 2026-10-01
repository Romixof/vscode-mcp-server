import * as assert from 'assert';
import proxyquire from 'proxyquire';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ExecFileStub = (command: string, args: string[], options: { timeout?: number; windowsHide?: boolean }, callback: (error: Error | null, stdout: string | Buffer, stderr: string) => void) => void;

interface BinariesModule {
        probeBinary(name: string, hint: string, platform?: NodeJS.Platform): Promise<{ name: string; found: boolean; path?: string; hint?: string }>;
        probePdfBinaries(): Promise<Array<{ name: string; found: boolean; path?: string; hint?: string }>>;
        POPPLER_HINT: string;
        TESSERACT_HINT: string;
}

function loadBinaries(execFile: ExecFileStub): BinariesModule {
        return proxyquire('../utils/binaries', { child_process: { execFile } }) as BinariesModule;
}

function ok(stdout: string): ExecFileStub {
        return (_command, _args, _options, callback) => callback(null, stdout, '');
}

function missing(): ExecFileStub {
        return (_command, _args, _options, callback) => callback(new Error('exit 1'), '', '');
}

suite('binary probe', () => {
        test('a binary on PATH is reported found with its path', async () => {
                const binaries = loadBinaries(ok('C:/poppler/pdftotext.exe\n'));
                const status = await binaries.probeBinary('pdftotext', binaries.POPPLER_HINT, 'linux');
                assert.strictEqual(status.found, true);
                assert.strictEqual(status.path, 'C:/poppler/pdftotext.exe');
        });

        test('a missing binary carries the install hint', async () => {
                const binaries = loadBinaries(missing());
                const status = await binaries.probeBinary('tesseract', binaries.TESSERACT_HINT, 'linux');
                assert.strictEqual(status.found, false);
                assert.strictEqual(status.hint, binaries.TESSERACT_HINT);
                assert.ok(/UB-Mannheim\.TesseractOCR/.test(binaries.TESSERACT_HINT), 'the tesseract hint must carry the working winget id');
        });

        test('windows probes where.exe and posix probes command -v', async () => {
                const calls: string[] = [];
                const record: ExecFileStub = (command, args, _options, callback) => {
                        calls.push(`${command} ${args.join(' ')}`);
                        callback(null, 'hit', '');
                };
                const binaries = loadBinaries(record);
                await binaries.probeBinary('pdftoppm', binaries.POPPLER_HINT, 'win32');
                await binaries.probeBinary('pdftoppm', binaries.POPPLER_HINT, 'linux');
                assert.ok(calls[0].startsWith('where.exe pdftoppm'), calls[0]);
                assert.ok(calls[1].includes('command -v pdftoppm'), calls[1]);
        });

        test('a probe that errors resolves as missing rather than rejecting', async () => {
                const binaries = loadBinaries((_c, _a, _o, callback) => callback(new Error('timeout'), '', ''));
                const status = await binaries.probeBinary('pdftotext', binaries.POPPLER_HINT, 'linux');
                assert.strictEqual(status.found, false);
        });

        test('the doctor covers the four pdf binaries plus git bash', async () => {
                const binaries = loadBinaries(ok('/usr/bin/bin\n'));
                const statuses = await binaries.probePdfBinaries();
                const names = statuses.map(s => s.name);
                for (const expected of ['pdftotext', 'pdfinfo', 'pdftoppm', 'tesseract', 'bash (Git Bash)']) {
                        assert.ok(names.includes(expected), `${expected} must be checked. Got: ${names.join(', ')}`);
                }
        });
});

type HandlerResult = { content?: Array<{ type: string; text?: string }> };
type ToolHandler = () => Promise<HandlerResult>;

suite('server info reports the binary picture', () => {
        function captureInfoText(): () => Promise<string> {
                let captured: ToolHandler | undefined;
                const probe = {
                        tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
                                if (name === 'get_server_info_code') {
                                        captured = handler;
                                }
                        }
                } as unknown as McpServer;
                const advanced = proxyquire('../tools/advanced-tools', {
                        '../utils/binaries': {
                                probePdfBinaries: async () => [
                                        { name: 'pdftotext', found: true, path: '/usr/bin/pdftotext' },
                                        { name: 'tesseract', found: false, hint: 'UB-Mannheim.TesseractOCR' }
                                ]
                        }
                }) as typeof import('../tools/advanced-tools');
                advanced.registerAdvancedTools(probe, { host: '127.0.0.1', port: 3400 });
                assert.ok(captured, 'get_server_info_code handler was not registered');
                return async () => {
                        const result = await (captured as ToolHandler)();
                        return (result.content ?? []).map(c => c.text ?? '').join('\n');
                };
        }

        test('every checked binary gets a line, found or missing', async () => {
                const text = await captureInfoText()();
                assert.ok(text.includes('Binaries:'), `the doctor block is missing:\n${text}`);
                assert.ok(text.includes('pdftotext: found (/usr/bin/pdftotext)'), `a present binary must show its path:\n${text}`);
                assert.ok(text.includes('tesseract: missing'), `a missing binary must say so:\n${text}`);
        });

        test('a missing binary is named with its install hint and a verdict', async () => {
                const text = await captureInfoText()();
                assert.ok(text.includes('UB-Mannheim.TesseractOCR'), `the install hint must travel with the verdict:\n${text}`);
                assert.ok(/tesseract unavailable/i.test(text), `the verdict must name what is unavailable:\n${text}`);
        });
});