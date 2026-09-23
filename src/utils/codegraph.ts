import * as fs from 'fs';
import * as path from 'path';
import { listWorkspaceFolders } from './workspace';



export const CODEGRAPH_VERSION = 1;

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CALLS_PER_FILE = 2000;
const MAX_DECLS_PER_FILE = 500;

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage',
    '__pycache__', '.venv', 'venv', 'target', '.gradle', 'bin', 'obj',
    '.vscode-mcp', '.codegraph', '.vscode', '.svn'
]);

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

const CALL_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
    'new', 'delete', 'void', 'super', 'import', 'require', 'constructor',
    'async', 'await', 'yield', 'else', 'do', 'try', 'throw', 'case', 'with',
    'print', 'def', 'class', 'lambda', 'not', 'in', 'is', 'and', 'or'
]);

export interface Decl { name: string; kind: 'function' | 'class' | 'method' | 'variable'; line: number; }
export interface CallRef { name: string; line: number; }

export interface FileEntry {
    mtimeMs: number;
    size: number;
    decls: Decl[];
    calls: CallRef[];
    imports: string[];
}


interface FileEntryRaw {
    mtimeMs: number;
    size: number;
    decls: Decl[];
    calls: CallRef[];
    imports: string[];
    rawImports?: string[];
}

export interface CodeGraphIndex {
    version: number;
    builtAt: number;
    files: Record<string, FileEntry>;
}



const RE_FUNCTION = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
const RE_CLASS = /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const RE_ARROW = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
const RE_CONST_FN = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/g;
const RE_METHOD = /^\s{2,}(?:(?:public|private|protected|static|readonly|override|async)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{}]*\)\s*(?::[^{;]+)?\{/;
const RE_PY_DEF = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
const RE_PY_CLASS = /^\s*class\s+([A-Za-z_]\w*)/gm;
const RE_CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const RE_TS_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
const RE_PY_FROM = /^\s*from\s+([.\w]+)\s+import/gm;
const RE_PY_IMPORT = /^\s*import\s+([.\w]+)/gm;

function extractDecls(line: string, isPython: boolean, out: Decl[]): void {
    if (isPython) {
        let m: RegExpExecArray | null;
        RE_PY_DEF.lastIndex = 0;
        if ((m = RE_PY_DEF.exec(line))) { out.push({ name: m[1], kind: 'function', line: 0 }); return; }
        RE_PY_CLASS.lastIndex = 0;
        if ((m = RE_PY_CLASS.exec(line))) { out.push({ name: m[1], kind: 'class', line: 0 }); return; }
        return;
    }
    let m: RegExpExecArray | null;
    RE_FUNCTION.lastIndex = 0;
    if ((m = RE_FUNCTION.exec(line))) { out.push({ name: m[1], kind: 'function', line: 0 }); return; }
    RE_CLASS.lastIndex = 0;
    if ((m = RE_CLASS.exec(line))) { out.push({ name: m[1], kind: 'class', line: 0 }); return; }
    RE_ARROW.lastIndex = 0;
    if ((m = RE_ARROW.exec(line))) { out.push({ name: m[1], kind: 'function', line: 0 }); return; }
    RE_CONST_FN.lastIndex = 0;
    if ((m = RE_CONST_FN.exec(line))) { out.push({ name: m[1], kind: 'function', line: 0 }); return; }
    const mm = RE_METHOD.exec(line);
    if (mm && !CALL_KEYWORDS.has(mm[1])) {
        out.push({ name: mm[1], kind: 'method', line: 0 });
    }
}

function extractCalls(line: string, isPython: boolean, out: CallRef[]): void {
    RE_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = RE_CALL.exec(line)) !== null) {
        if (count++ > 12 || out.length >= MAX_CALLS_PER_FILE) { return; }
        const name = m[1];
        if (CALL_KEYWORDS.has(name)) { continue; }

        const before = line.slice(Math.max(0, m.index - 1), m.index);
        if (before === '<') { continue; }
        out.push({ name, line: 0 });
        if (isPython) { break; }
    }
}

function resolveImport(fromFile: string, spec: string, allFiles: Set<string>): string | undefined {
    if (!spec.startsWith('.')) {

        const cand = spec.replace(/\./g, '/') + '.py';
        if (allFiles.has(cand)) { return cand; }
        return undefined;
    }
    const basePosix = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile.split(path.sep).join('/')), spec.split(path.sep).join('/')));
    const candidates = [
        basePosix,
        `${basePosix}.ts`, `${basePosix}.tsx`, `${basePosix}.js`, `${basePosix}.jsx`,
        `${basePosix}.mjs`, `${basePosix}.cjs`, `${basePosix}.py`,
        `${basePosix}/index.ts`, `${basePosix}/index.tsx`, `${basePosix}/index.js`, `${basePosix}/index.jsx`
    ];
    for (const c of candidates) {
        if (allFiles.has(c)) { return c; }
    }
    return undefined;
}

function scanFile(fsPath: string, relPosix: string, stat: fs.Stats): FileEntryRaw {
    const entry: FileEntryRaw = { mtimeMs: stat.mtimeMs, size: stat.size, decls: [], calls: [], imports: [] };
    let content: string;
    try {
        const buf = fs.readFileSync(fsPath);
        if (buf.subarray(0, 8192).includes(0)) { return entry; }
        content = buf.toString('utf-8');
    } catch {
        return entry;
    }
    const isPython = relPosix.endsWith('.py');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (entry.decls.length < MAX_DECLS_PER_FILE) {
            const before = entry.decls.length;
            extractDecls(line, isPython, entry.decls);
            for (let k = before; k < entry.decls.length; k++) {
                entry.decls[k].line = i + 1;
            }
        }
        if (entry.calls.length < MAX_CALLS_PER_FILE) {
            const beforeCalls = entry.calls.length;
            extractCalls(line, isPython, entry.calls);
            for (let k = beforeCalls; k < entry.calls.length; k++) {
                entry.calls[k].line = i + 1;
            }
        }
    }
    const specs: string[] = [];
    if (!isPython) {
        RE_TS_IMPORT.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RE_TS_IMPORT.exec(content)) !== null) {
            specs.push(m[1]);
            if (specs.length > 200) { break; }
        }
    } else {
        let m: RegExpExecArray | null;
        RE_PY_FROM.lastIndex = 0;
        while ((m = RE_PY_FROM.exec(content)) !== null) { specs.push(m[1]); }
        RE_PY_IMPORT.lastIndex = 0;
        while ((m = RE_PY_IMPORT.exec(content)) !== null) { specs.push(m[1]); }
    }
    entry.rawImports = specs;
    return entry;
}



function collectFiles(root: string): Map<string, { fsPath: string; stat: fs.Stats }> {
    const found = new Map<string, { fsPath: string; stat: fs.Stats }>();
    const stack: string[] = [''];
    while (stack.length > 0 && found.size < MAX_FILES) {
        const rel = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (found.size >= MAX_FILES) { break; }
            const relPosix = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) { continue; }
                stack.push(relPosix);
                continue;
            }
            if (!e.isFile()) { continue; }
            if (!CODE_EXTS.has(path.extname(e.name).toLowerCase())) { continue; }
            try {
                const fsPath = path.join(root, relPosix);
                const stat = fs.statSync(fsPath);
                if (stat.size > MAX_FILE_BYTES) { continue; }
                found.set(relPosix, { fsPath, stat });
            } catch {  }
        }
    }
    return found;
}



let indexCache: { root: string; index: CodeGraphIndex; builtAt: number } | undefined;
const INDEX_TTL_MS = 5000;

export function codegraphCachePath(root: string): string {
    return path.join(root, '.codegraph', 'index.json');
}

function loadDiskIndex(root: string): CodeGraphIndex | undefined {
    try {
        const raw = fs.readFileSync(codegraphCachePath(root), 'utf-8');
        const parsed = JSON.parse(raw) as CodeGraphIndex;
        if (parsed && parsed.version === CODEGRAPH_VERSION && parsed.files) {
            return parsed;
        }
    } catch {  }
    return undefined;
}

function saveDiskIndex(root: string, index: CodeGraphIndex): void {
    try {
        fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
        fs.writeFileSync(codegraphCachePath(root), JSON.stringify(index));
    } catch {  }
}

export interface IndexStats { files: number; rescanned: number; cached: boolean; }

export function getWorkspaceIndex(root: string, forceRescan = false): { index: CodeGraphIndex; stats: IndexStats } {
    if (!forceRescan && indexCache && indexCache.root === root && Date.now() - indexCache.builtAt < INDEX_TTL_MS) {
        return { index: indexCache.index, stats: { files: Object.keys(indexCache.index.files).length, rescanned: 0, cached: true } };
    }

    const disk = forceRescan ? undefined : loadDiskIndex(root);
    const index: CodeGraphIndex = { version: CODEGRAPH_VERSION, builtAt: Date.now(), files: {} };
    let rescanned = 0;
    let changed = false;

    const files = collectFiles(root);
    const allNames = new Set(files.keys());

    for (const [rel, info] of files) {
        const prev = disk?.files[rel];
        if (prev && Math.abs(prev.mtimeMs - info.stat.mtimeMs) < 2 && Math.abs(prev.size - info.stat.size) < 1) {
            index.files[rel] = prev;
            continue;
        }
        const entry = scanFile(info.fsPath, rel, info.stat);
        const raw = entry as FileEntryRaw;
        const specs = raw.rawImports ?? [];
        delete raw.rawImports;
        entry.imports = specs
            .map(s => resolveImport(rel, s, allNames))
            .filter((x): x is string => !!x);
        index.files[rel] = entry;
        rescanned += 1;
        changed = true;
    }

    if (disk) {
        for (const rel of Object.keys(disk.files)) {
            if (!files.has(rel)) {
                changed = true;
            }
        }
    }

    if (changed || !disk) {
        saveDiskIndex(root, index);
    }
    indexCache = { root, index, builtAt: Date.now() };
    return { index, stats: { files: Object.keys(index.files).length, rescanned, cached: false } };
}



export interface CallEdge { caller: string; callee: string; count: number; }

export interface GraphBundle {
    decls: Map<string, Array<{ file: string; line: number; kind: string }>>;
    callees: Map<string, Map<string, number>>;
    callers: Map<string, Map<string, number>>;
    moduleCalls: Array<{ file: string; callee: string; line: number }>;
    importers: Map<string, Set<string>>;
}

export function buildGraphBundle(index: CodeGraphIndex): GraphBundle {
    const decls: GraphBundle['decls'] = new Map();
    const callees = new Map<string, Map<string, number>>();
    const callers = new Map<string, Map<string, number>>();
    const moduleCalls: GraphBundle['moduleCalls'] = [];
    const importers = new Map<string, Set<string>>();

    const addEdge = (from: string, to: string): void => {
        if (from === to) { return; }
        let inner = callees.get(from);
        if (!inner) { inner = new Map(); callees.set(from, inner); }
        inner.set(to, (inner.get(to) ?? 0) + 1);
        let rinner = callers.get(to);
        if (!rinner) { rinner = new Map(); callers.set(to, rinner); }
        rinner.set(from, (rinner.get(from) ?? 0) + 1);
    };

    for (const [file, entry] of Object.entries(index.files)) {
        for (const d of entry.decls) {
            const list = decls.get(d.name) ?? [];
            list.push({ file, line: d.line, kind: d.kind });
            decls.set(d.name, list);
        }
        for (const imp of entry.imports) {
            let set = importers.get(imp);
            if (!set) { set = new Set(); importers.set(imp, set); }
            set.add(file);
        }

        const sorted = [...entry.decls].sort((a, b) => a.line - b.line);
        const sortedCalls = [...entry.calls].sort((a, b) => a.line - b.line);
        let di = 0;
        for (const call of sortedCalls) {
            while (di < sorted.length && sorted[di].line <= call.line) { di++; }
            const owner = di > 0 ? sorted[di - 1] : undefined;
            if (owner) {
                addEdge(owner.name, call.name);
            } else {
                moduleCalls.push({ file, callee: call.name, line: call.line });
            }
        }
    }
    return { decls, callees, callers, moduleCalls, importers };
}

export function isTestFile(relPath: string): boolean {
    const base = path.posix.basename(relPath).toLowerCase();
    return /\.(test|spec)\.[a-z]+$/.test(base) || /(^|\/)(tests?|__tests__)(\/|$)/.test(relPath.toLowerCase());
}
