import { execFile } from 'child_process';

/**
 * Runs git directly, without a shell. Arguments are passed as an array, so a
 * path, an author name or a date coming from an MCP client can never be read
 * as shell syntax ($(...), backticks, quotes, ;, &, |). Every git call that
 * includes client input must go through here instead of the terminal.
 */
export function runGit(args: string[], cwd: string, timeoutMs = 30000): Promise<{ output: string; exitCode: number }> {
    return new Promise(resolve => {
        execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            const out = String(stdout ?? '');
            const errText = String(stderr ?? '');
            if (err) {
                const code = typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                    ? (err as unknown as { code: number }).code
                    : 1;
                const message = [out, errText].filter(s => s.trim()).join('\n') || err.message;
                resolve({ output: message.trimEnd(), exitCode: code || 1 });
                return;
            }
            resolve({ output: (out + (errText.trim() ? `\n${errText}` : '')).trimEnd(), exitCode: 0 });
        });
    });
}

/**
 * Value for a git option that takes a free-form string (--author=, --grep=,
 * --since=). Rejects control characters; the value is still passed as one
 * argv entry, never through a shell.
 */
export function gitOptionValue(name: string, value: string): string {
    if (/[\u0000-\u001F\u007F]/.test(value)) {
        throw new Error(`${name} contains control characters`);
    }
    return value;
}

/**
 * A git revision supplied by a client. A leading "-" would be read as an
 * option (for example --output=<file>), so it is refused.
 */
export function gitRevision(value: string): string {
    const v = value.trim();
    if (!v || v.startsWith('-') || /[\u0000-\u001F\u007F\s]/.test(v)) {
        throw new Error(`Invalid git revision: "${value}"`);
    }
    return v;
}
