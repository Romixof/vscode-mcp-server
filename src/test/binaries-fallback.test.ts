import * as assert from 'assert';
import proxyquire from 'proxyquire';

interface BinariesModule {
        probeBinary(name: string, hint: string, platform?: NodeJS.Platform): Promise<{ name: string; found: boolean; path?: string; hint?: string }>;
        windowsBinaryExists(dir: string, name: string): boolean;
        msysToWindowsPath(dir: string): string;
        WINDOWS_FALLBACK_DIRS: Record<string, string[]>;
        POPPLER_HINT: string;
        TESSERACT_HINT: string;
}

function loadBinaries(execFile: (command: string, args: string[], options: { timeout?: number }, callback: (error: Error | null, stdout: string | Buffer, stderr: string) => void) => void): BinariesModule {
        return proxyquire('../utils/binaries', { child_process: { execFile } }) as BinariesModule;
}

function missing(): (command: string, args: string[], options: { timeout?: number }, callback: (error: Error | null, stdout: string | Buffer, stderr: string) => void) => void {
        return (_command, _args, _options, callback) => callback(new Error('exit 1'), '', '');
}

	suite('windows fallback discovery', () => {
        test('an msys-style fallback dir resolves to a real windows path Node can stat', () => {
                const binaries = loadBinaries(missing());
                if (process.platform === 'win32') {
                        assert.doesNotThrow(() => binaries.windowsBinaryExists('/c/Program Files/Tesseract-OCR', 'tesseract'),
                                'the check must not throw on win32 for an msys-style dir');
                }
                assert.strictEqual(
                        binaries.msysToWindowsPath('/c/Program Files/Tesseract-OCR'),
                        'C:\\Program Files\\Tesseract-OCR',
                        'the incident msys dir must convert to a windows path'
                );
                assert.strictEqual(binaries.msysToWindowsPath('C:\\plain\\win'), 'C:\\plain\\win', 'a non-msys dir passes through unchanged');
        });

        test('a missing binary on win32 with a real fallback install is reported found at the windows path', async () => {
                const binaries = loadBinaries(missing());
                const status = await binaries.probeBinary('tesseract', binaries.TESSERACT_HINT, 'win32');
                const realInstall = binaries.WINDOWS_FALLBACK_DIRS.tesseract.some(dir => binaries.windowsBinaryExists(dir, 'tesseract'));
                if (realInstall) {
                        assert.strictEqual(status.found, true, `tesseract exists on this machine at a fallback dir, the probe must find it: ${JSON.stringify(status)}`);
                        assert.ok(/^[A-Za-z]:\\/.test(status.path ?? ''), `the reported path must be a windows path, not an msys path: ${status.path}`);
                } else {
                        assert.strictEqual(status.found, false, 'no fallback install on this machine means the probe stays honest');
                }
        });

        test('a poppler binary has no fallback dirs and stays PATH-only', async () => {
                const binaries = loadBinaries(missing());
                const status = await binaries.probeBinary('pdftotext', binaries.POPPLER_HINT, 'win32');
                assert.strictEqual(binaries.WINDOWS_FALLBACK_DIRS.pdftotext, undefined, 'only tesseract ships fallback dirs');
                assert.strictEqual(status.found, false);
        });
});
