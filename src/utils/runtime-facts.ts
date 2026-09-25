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

export function detectRuntimeFacts(): RuntimeFacts {
        const facts: RuntimeFacts = { platform: process.platform, python: 'not found' };
        const { execFileSync } = require('child_process') as typeof import('child_process');
        const probe = (code: string): boolean => {
                try {
                        execFileSync('python', ['-c', code], { stdio: 'ignore', timeout: 4000, windowsHide: true });
                        return true;
                } catch {
                        return false;
                }
        };
        try {
                facts.python = execFileSync('python', ['-c', 'import platform;print(platform.python_version())'], {
                        stdio: ['ignore', 'pipe', 'ignore'],
                        timeout: 4000,
                        windowsHide: true
                }).toString().trim();
        } catch {
                return facts;
        }
        const libs: Record<string, boolean> = {};
        for (const [label, module] of LIB_PROBES) {
                libs[label] = probe(`import ${module}`);
        }
        facts.libs = libs;
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
