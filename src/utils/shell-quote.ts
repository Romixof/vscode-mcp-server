import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Single quotes are literal in bash AND PowerShell, as long as the value holds
 * no single quote of its own. The two shells escape a quote differently
 * (bash: '\'' — PowerShell: ''), and the terminal helper may retry a command
 * in the other shell, so a value that contains one is refused instead of
 * escaped. PowerShell also treats the typographic quotes ‘ ’ ‚ ‛ as quotes.
 */
const UNSAFE_IN_QUOTES = /['‘’‚‛\u0000-\u001F\u007F]/;

export function quoteArg(value: string): string {
    if (UNSAFE_IN_QUOTES.test(value)) {
        throw new Error(`Refusing a shell argument that contains a quote or a control character: ${JSON.stringify(value)}`);
    }
    return `'${value}'`;
}

export function isShellSafe(value: string): boolean {
    return !UNSAFE_IN_QUOTES.test(value);
}

const safeCopies = new Map<string, string>();

/**
 * Path to give a terminal command for an existing input file. When the real
 * path holds a quote (a French file name like "l'été.pdf"), the file is
 * copied once to a temporary file with a plain name and that copy is used.
 */
export function shellSafeInputPath(fsPath: string): string {
    if (isShellSafe(fsPath)) {
        return fsPath;
    }
    const st = fs.statSync(fsPath);
    const key = `${fsPath}|${st.size}|${st.mtimeMs}`;
    const cached = safeCopies.get(key);
    if (cached && fs.existsSync(cached)) {
        return cached;
    }
    const dir = os.tmpdir();
    if (!isShellSafe(dir)) {
        throw new Error(`The temporary folder path contains a quote: ${dir}`);
    }
    const ext = path.extname(fsPath).replace(/[^A-Za-z0-9.]/g, '');
    const copy = path.join(dir, `mcp-input-${crypto.randomBytes(8).toString('hex')}${ext}`);
    fs.copyFileSync(fsPath, copy);
    safeCopies.set(key, copy);
    return copy;
}
