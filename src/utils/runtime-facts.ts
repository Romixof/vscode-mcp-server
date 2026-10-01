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

let cachedRuntime: Promise<RuntimeFacts> | undefined;

function probeRuntime(): Promise<RuntimeFacts> {
        const facts: RuntimeFacts = { platform: process.platform, python: 'not on the extension host PATH' };
        const { execFile } = require('child_process') as typeof import('child_process');
        return new Promise<RuntimeFacts>(resolve => {
                execFile('python', ['-c', PROBE_SCRIPT], { timeout: 4000, windowsHide: true }, (error, stdout) => {
                        if (!error && stdout) {
                                try {
                                        const parsed = JSON.parse(stdout.toString().trim()) as { python: string; libs: Record<string, boolean> };
                                        facts.python = parsed.python;
                                        const libs: Record<string, boolean> = {};
                                        for (const [label, module] of LIB_PROBES) {
                                                libs[label] = parsed.libs[module] === true;
                                        }
                                        facts.libs = libs;
                                }
                                catch {
                                }
                        }
                        resolve(facts);
                });
        });
}

export function detectRuntimeFacts(): Promise<RuntimeFacts> {
        if (!cachedRuntime) {
                cachedRuntime = probeRuntime();
        }
        return cachedRuntime;
}

export function runtimeSection(facts: RuntimeFacts): string {
        const lines = [
                `Interpreter: ${facts.python === 'not on the extension host PATH'
                        ? 'python is not on the extension host PATH. The integrated terminal usually still has it — run `command -v python` once, then use the absolute path.'
                        : `python ${facts.python}`}`,
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
