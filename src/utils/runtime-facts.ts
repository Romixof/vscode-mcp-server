export interface RuntimeFacts {
        platform: NodeJS.Platform;
        python: string;
        libs?: Record<string, boolean>;
}

const LIB_PROBES: Array<[string, string]> = [
        ['reportlab', 'reportlab'],
        ['pypdf', 'pypdf'],
        ['pdfplumber', 'pdfplumber'],
        ['pypdfium2', 'pypdfium2'],
        ['fitz', 'fitz'],
        ['PIL', 'PIL'],
        ['weasyprint', 'weasyprint']
];

const PROBE_SCRIPT = [
        'import json,platform',
        `mods=${JSON.stringify(LIB_PROBES.map(p => p[1]))}`,
        'out={}',
        'for m in mods:',
        '    try:',
        '        __import__(m); out[m]=True',
        '    except BaseException: out[m]=False',
        'print(json.dumps({"python":platform.python_version(),"libs":out}))'
].join('\n');

let cachedRuntime: RuntimeFacts | undefined;

export function detectRuntimeFacts(): RuntimeFacts {
        if (cachedRuntime) {
                return cachedRuntime;
        }
        const facts: RuntimeFacts = { platform: process.platform, python: 'not found' };
        const { execFileSync } = require('child_process') as typeof import('child_process');
        try {
                const raw = execFileSync('python', ['-c', PROBE_SCRIPT], {
                        stdio: ['ignore', 'pipe', 'ignore'],
                        timeout: 4000,
                        windowsHide: true
                }).toString().trim();
                const parsed = JSON.parse(raw) as { python: string; libs: Record<string, boolean> };
                facts.python = parsed.python;
                const libs: Record<string, boolean> = {};
                for (const [label, module] of LIB_PROBES) {
                        libs[label] = parsed.libs[module] === true;
                }
                facts.libs = libs;
        } catch {
        }
        cachedRuntime = facts;
        return facts;
}

export function runtimeSection(facts: RuntimeFacts): string {
        const lines = [
                `Interpreter: python ${facts.python}`,
                `Platform: ${facts.platform}`,
                `CWD: ${process.cwd()}`
        ];
        if (facts.libs) {
                const present = Object.entries(facts.libs).filter(([, ok]) => ok).map(([name]) => name);
                const missing = Object.entries(facts.libs).filter(([, ok]) => !ok).map(([name]) => name);
                if (present.length > 0) {
                        lines.push(`Python libraries importable: ${present.join(', ')}`);
                }
                if (missing.length > 0) {
                        lines.push(`Missing (do not import): ${missing.join(', ')}`);
                }
        }
        return lines.join('\n');
}

const PYTHON_HEAD = /^\s*(?:python3?|py)\b/;

export function pythonCacheGuard(command: string, platform: NodeJS.Platform = process.platform): string | null {
        if (platform !== 'win32' && platform !== 'linux') {
                return null;
        }
        if (!PYTHON_HEAD.test(command)) {
                return null;
        }
        if (command.includes('PYTHONDONTWRITEBYTECODE')) {
                return null;
        }
        return `PYTHONDONTWRITEBYTECODE=1 ${command.trimStart()}`;
}
