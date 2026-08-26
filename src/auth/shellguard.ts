export interface ShellVerdict {
    allowed: boolean;
    rule?: string;
    normalized: string;
}

const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const BLOCKLIST: Array<{ rule: string; re: RegExp }> = [
    { rule: 'credential-store', re: /state\.vscdb/i },
    { rule: 'ssh-keys', re: /\.ssh\b/i },
    { rule: 'aws-credentials', re: /\.aws\b/i },
    { rule: 'vscode-profiles', re: /AppData.*Code.*User|\.config\/Code/i },
    { rule: 'registry-write', re: /\breg(\.exe)?\s+(add|delete|import|load)\b/i },
    { rule: 'disk-destructive', re: /\b(format\b|diskpart\b|cipher\s+\/w)/i },
    { rule: 'recursive-delete-root', re: /(Remove-Item|rm\s+-rf|rmdir\s+\/s)\s+[^&|;]*[A-Za-z]:\\?\s*$/i },
    { rule: 'dos-del-tree', re: /\bdel\s+\/[sq]\b|\brd\s+\/s\b/i },
    { rule: 'service-persistence', re: /\bschtasks\b|\bsc(\.exe)?\s+config\b|\bNew-Service\b/i },
    { rule: 'defender-off', re: /Set-MpPreference/i },
    { rule: 'encoded-payload', re: /powershell[^&|;]*\s-enc(odedcommand)?\b/i },
    { rule: 'download-execute', re: /(curl|wget|iwr|Invoke-WebRequest)[^&|;]*(\|\s*(iex|Invoke-Expression|iwr\s.*-UseBasicParsing.*\|))|(iex\s*\(\s*(new-object\s+net\.webclient|iwr))/i }
];

const EXTRA_PATTERNS_KEY = 'shellguard.extra';

let extraPatterns: Array<{ rule: string; re: RegExp }> = [];

export function setExtraBlockedPatterns(patterns: Array<{ rule: string; regex: RegExp }>): void {
    extraPatterns = patterns.map(p => ({ rule: p.rule, re: p.regex }));
}

function normalizeForAnalysis(raw: string): string {
    let s = raw.normalize('NFKC');
    s = s.replace(INVISIBLE, '');
    s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
    s = s.replace(/(["'`^])/g, '');
    s = s.replace(/\s+/g, ' ');
    return s.trim();
}

function splitCompound(command: string): string[] {
    return command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(s => s.length > 0);
}

function fullwidthToAscii(s: string): string {
    let out = '';
    for (const ch of s) {
        const code = ch.charCodeAt(0);
        out += code >= 0xFF01 && code <= 0xFF5E ? String.fromCharCode(code - 0xFEE0) : ch;
    }
    return out;
}

export function checkShellCommand(rawCommand: string): ShellVerdict {
    const normalized = normalizeForAnalysis(fullwidthToAscii(rawCommand));
    const segments = splitCompound(normalized);
    for (const seg of segments) {
        for (const { rule, re } of [...BLOCKLIST, ...extraPatterns]) {
            if (re.test(seg) || re.test(normalized)) {
                return { allowed: false, rule, normalized };
            }
        }
    }
    return { allowed: true, normalized };
}
