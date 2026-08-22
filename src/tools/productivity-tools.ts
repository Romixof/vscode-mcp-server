import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';

const DEFAULT_EXCLUDES = [
	'**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.js',
	'**/*.map', '**/vendor/**', '**/.next/**', '**/target/**', '**/__pycache__/**',
	'**/.vscode-mcp/**'
];

// single-pass glob translation, same approach as the documentation tools
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	let body = '';
	let i = 0;
	while (i < escaped.length) {
		if (escaped.startsWith('**/', i)) {
			body += '(?:[^/]+/)*';
			i += 3;
		} else if (escaped.startsWith('**', i)) {
			body += '[\\s\\S]*';
			i += 2;
		} else if (escaped[i] === '*') {
			body += '[^/]*';
			i += 1;
		} else {
			body += escaped[i];
			i += 1;
		}
	}
	return new RegExp(`^${body}$`);
}

async function getWorkspaceRoot(): Promise<string> {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		throw new Error('No workspace folder is open');
	}
	return vscode.workspace.workspaceFolders[0].uri.fsPath;
}

interface WorkspaceFile {
	fullPath: string;
	relativePath: string;
}

function collectFiles(rootDir: string, excludeRegexes: RegExp[], includeRegexes: RegExp[], includeAll: boolean): WorkspaceFile[] {
	const files: WorkspaceFile[] = [];
	function walk(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
			if (excludeRegexes.some(regex => regex.test(relativePath))) {
				continue;
			}
			if (!includeAll && !includeRegexes.some(regex => regex.test(relativePath))) {
				continue;
			}
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				files.push({ fullPath, relativePath });
			}
		}
	}
	walk(rootDir);
	return files;
}

function parseExcludeInclude(exclude?: string[], include?: string[]): { excludeRegexes: RegExp[]; includeRegexes: RegExp[]; includeAll: boolean } {
	const excludePatterns = exclude ?? DEFAULT_EXCLUDES;
	const includePatterns = include ?? ['**/*'];
	return {
		excludeRegexes: excludePatterns.map(globToRegExp),
		includeRegexes: includePatterns.map(globToRegExp),
		includeAll: includePatterns.includes('**/*')
	};
}

// declarations we consider "exports" for dead-code purposes
const EXPORT_DECLARATION_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
	{ regex: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
	{ regex: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'variable' },
	{ regex: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
	{ regex: /^export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
	{ regex: /^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
	{ regex: /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/, kind: 'cjs-export' }
];

const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

async function findDeadSymbols(options: { path?: string; include?: string[]; exclude?: string[]; maxResults?: number }): Promise<{ totalScanned: number; totalDead: number; dead: Array<{ symbol: string; kind: string; file: string; line: number }> }> {
	const workspaceRoot = options.path
		? path.isAbsolute(options.path) ? options.path : path.join(await getWorkspaceRoot(), options.path)
		: await getWorkspaceRoot();
	const { excludeRegexes, includeRegexes, includeAll } = parseExcludeInclude(options.exclude, options.include);
	const maxResults = options.maxResults ?? 50;

	const files = collectFiles(workspaceRoot, excludeRegexes, includeRegexes, includeAll)
		.filter(f => CODE_EXTENSIONS.includes(path.extname(f.fullPath)) && !f.fullPath.endsWith('.d.ts'));

	const contents = files.map(f => ({ ...f, lines: (() => {
		try {
			return fs.readFileSync(f.fullPath, 'utf-8').split('\n');
		} catch {
			return [];
		}
	})() }));

	interface DeclaredSymbol { symbol: string; kind: string; file: string; line: number }
	const declared: DeclaredSymbol[] = [];
	for (const file of contents) {
		file.lines.forEach((lineText, lineIndex) => {
			const trimmed = lineText.trim();
			if (!trimmed.startsWith('export') && !trimmed.includes('exports.')) {
				return;
			}
			for (const pattern of EXPORT_DECLARATION_PATTERNS) {
				const match = trimmed.match(pattern.regex);
				if (match) {
					declared.push({ symbol: match[1], kind: pattern.kind, file: file.relativePath, line: lineIndex + 1 });
					return;
				}
			}
		});
	}

	const dead: DeclaredSymbol[] = [];
	for (const decl of declared) {
		const wordRegex = new RegExp(`\\b${decl.symbol.replace(/\$/g, '\\$')}\\b`);
		let occurrences = 0;
		for (const file of contents) {
			for (const lineText of file.lines) {
				if (wordRegex.test(lineText)) {
					occurrences += 1;
					if (occurrences > 1) {
						break;
					}
				}
			}
			if (occurrences > 1) {
				break;
			}
		}
		if (occurrences <= 1) {
			dead.push(decl);
			if (dead.length >= maxResults) {
				break;
			}
		}
	}

	return { totalScanned: declared.length, totalDead: dead.length, dead };
}

interface SnapshotEntry { path: string; size: number; hash: string }

async function buildSnapshotEntries(rootDir: string): Promise<SnapshotEntry[]> {
	const { excludeRegexes, includeRegexes, includeAll } = parseExcludeInclude(undefined, undefined);
	return collectFiles(rootDir, excludeRegexes, includeRegexes, includeAll).map(f => {
		const content = fs.readFileSync(f.fullPath);
		return {
			path: f.relativePath,
			size: content.length,
			hash: crypto.createHash('sha256').update(content).digest('hex')
		};
	}).sort((a, b) => a.path.localeCompare(b.path));
}

function snapshotsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vscode-mcp', 'snapshots');
}

async function snapshotWorkspace(action: 'save' | 'compare' | 'list', name?: string, baseline?: string): Promise<string> {
	const workspaceRoot = await getWorkspaceRoot();
	const dir = snapshotsDir(workspaceRoot);

	if (action === 'list') {
		if (!fs.existsSync(dir)) {
			return 'No snapshots saved yet.';
		}
		const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
		if (files.length === 0) {
			return 'No snapshots saved yet.';
		}
		return `Saved snapshots:\n${files.map(f => `- ${f.replace(/\.json$/, '')}`).join('\n')}`;
	}

	if (action === 'save') {
		if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new Error('Snapshot name is required and may only contain letters, digits, - and _');
		}
		fs.mkdirSync(dir, { recursive: true });
		const entries = await buildSnapshotEntries(workspaceRoot);
		const snapshot = { name, createdAt: new Date().toISOString(), fileCount: entries.length, totalBytes: entries.reduce((sum, e) => sum + e.size, 0), files: entries };
		fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(snapshot));
		return `Snapshot "${name}" saved: ${snapshot.fileCount} files, ${snapshot.totalBytes} bytes.\nUse action "compare" with this name later to see what changed.`;
	}

	if (!baseline) {
		throw new Error('A baseline snapshot name is required for compare');
	}
	const baselinePath = path.join(dir, `${baseline}.json`);
	if (!fs.existsSync(baselinePath)) {
		throw new Error(`Snapshot "${baseline}" does not exist — run action "save" first or pick a name from action "list"`);
	}
	const before = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as { files: SnapshotEntry[] };
	const afterFiles = await buildSnapshotEntries(workspaceRoot);

	const beforeMap = new Map(before.files.map(e => [e.path, e]));
	const afterMap = new Map(afterFiles.map(e => [e.path, e]));
	const added = afterFiles.filter(e => !beforeMap.has(e.path)).map(e => e.path);
	const removed = before.files.filter(e => !afterMap.has(e.path)).map(e => e.path);
	const modified = afterFiles.filter(e => {
		const prev = beforeMap.get(e.path);
		return prev && prev.hash !== e.hash;
	}).map(e => e.path);

	let output = `Comparing "${baseline}" against current workspace:\n`;
	output += `Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}\n`;
	for (const [label, list] of [['Added', added], ['Removed', removed], ['Modified', modified]] as const) {
		if (list.length > 0) {
			output += `\n${label}:\n${list.slice(0, 100).map(p => `- ${p}`).join('\n')}`;
			if (list.length > 100) {
				output += `\n... and ${list.length - 100} more`;
			}
		}
	}
	if (added.length + removed.length + modified.length === 0) {
		output += '\nNo changes since the baseline.';
	}
	return output;
}

const MAX_REGEX_MATCHES = 1000;

function locateIndex(text: string, index: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for (let i = 0; i < index; i++) {
		if (text[i] === '\n') {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

async function testRegex(pattern: string, flags: string, text: string | undefined, filePath: string | undefined, replace?: string): Promise<string> {
	if (!/^[\w]*$/.test(flags) || /[^dgimsuy]/.test(flags)) {
		throw new Error(`Invalid flags "${flags}" — allowed: d g i m s u y`);
	}
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
	} catch (error) {
		throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
	}

	let source = text ?? '';
	if (text === undefined) {
		if (!filePath) {
			throw new Error('Provide either "text" or "filePath"');
		}
		const workspaceRoot = await getWorkspaceRoot();
		const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
		try {
			source = fs.readFileSync(fullPath, 'utf-8');
		} catch {
			throw new Error(`Cannot read ${filePath}`);
		}
	}

	const matches: Array<{ text: string; line: number; column: number; groups: Record<string, string> }> = [];
	let m: RegExpExecArray | null;
	while ((m = regex.exec(source)) !== null && matches.length < MAX_REGEX_MATCHES) {
		const pos = locateIndex(source, m.index);
		matches.push({
			text: m[0],
			line: pos.line,
			column: pos.column,
			groups: m.groups ? Object.fromEntries(Object.entries(m.groups).filter(([, v]) => v !== undefined)) : {}
		});
		if (m[0] === '') {
			regex.lastIndex += 1;
		}
	}

	let output = `${matches.length} match(es)${matches.length >= MAX_REGEX_MATCHES ? ' (capped)' : ''}\n\n`;
	for (const match of matches.slice(0, 100)) {
		const groupInfo = Object.keys(match.groups).length > 0
			? ` groups: ${Object.entries(match.groups).map(([k, v]) => `${k}="${v}"`).join(', ')}`
			: '';
		output += `line ${match.line}, col ${match.column}: "${match.text}"${groupInfo}\n`;
	}
	if (matches.length > 100) {
		output += `... and ${matches.length - 100} more\n`;
	}
	if (replace !== undefined) {
		const replaced = source.replace(new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`), replace);
		const preview = replaced.length > 4000 ? `${replaced.slice(0, 4000)}\n... (${replaced.length} chars total)` : replaced;
		output += `\n--- Replace preview ---\n${preview}`;
	}
	return output;
}

type SupportedEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'latin1';

function startsWithBytes(buffer: Buffer, prefix: number[]): boolean {
	const head = Buffer.from(prefix);
	return buffer.length >= head.length && buffer.subarray(0, head.length).equals(head);
}

function decodeContent(buffer: Buffer, encoding: SupportedEncoding): string {
	switch (encoding) {
		case 'utf-8-bom':
			return startsWithBytes(buffer, [0xEF, 0xBB, 0xBF]) ? buffer.subarray(3).toString('utf-8') : buffer.toString('utf-8');
		case 'utf-16le':
			// files conventionally carry a BOM; strip it before decoding
			return startsWithBytes(buffer, [0xFF, 0xFE]) ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf16le');
		case 'latin1':
			return buffer.toString('latin1');
		default:
			return buffer.toString('utf-8');
	}
}

function encodeContent(text: string, encoding: SupportedEncoding): Buffer {
	switch (encoding) {
		case 'utf-8-bom':
			return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf-8')]);
		case 'utf-16le':
			return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
		case 'latin1':
			return Buffer.from(text, 'latin1');
		default:
			return Buffer.from(text, 'utf-8');
	}
}

function detectEncoding(buffer: Buffer): string {
	if (startsWithBytes(buffer, [0xEF, 0xBB, 0xBF])) {
		return 'utf-8-bom';
	}
	if (startsWithBytes(buffer, [0xFF, 0xFE])) {
		return 'utf-16le';
	}
	if (startsWithBytes(buffer, [0xFE, 0xFF])) {
		return 'utf-16be (not convertible, only detected)';
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(buffer);
		return 'utf-8';
	} catch {
		return 'latin1 (or unknown binary)';
	}
}

async function resolveWorkspaceFile(filePath: string): Promise<string> {
	const workspaceRoot = await getWorkspaceRoot();
	const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
	if (!fs.existsSync(fullPath)) {
		throw new Error(`File not found: ${filePath}`);
	}
	return fullPath;
}

async function handleEncodingConvert(filePath: string, from: SupportedEncoding, to: SupportedEncoding): Promise<string> {
	const fullPath = await resolveWorkspaceFile(filePath);
	const original = fs.readFileSync(fullPath);
	const text = decodeContent(original, from);
	const converted = encodeContent(text, to);
	fs.writeFileSync(fullPath, converted);
	return `Converted ${filePath} from ${from} to ${to}: ${original.length} bytes -> ${converted.length} bytes.`;
}

export function registerProductivityTools(server: McpServer): void {
	server.tool('find_dead_code_code', `Finds exported symbols that are never referenced anywhere else in the workspace.

WHEN TO USE: cleanup passes before a release, spotting leftovers after refactors.

Heuristic scanner: an export whose name appears only once across all scanned files (its own declaration) is reported as dead. Dynamic references such as obj["name"] are not counted.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		include: z.array(z.string()).optional().describe('Glob patterns to include'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
		maxResults: z.number().int().min(1).max(500).optional().default(50).describe('Maximum dead symbols to report')
	}, async ({ path: searchPath, include, exclude, maxResults }) => {
		const result = await findDeadSymbols({ path: searchPath, include, exclude, maxResults });
		if (result.dead.length === 0) {
			return { content: [{ type: 'text', text: `No dead exports found among ${result.totalScanned} exported symbols.` }] };
		}
		let output = `${result.totalDead} dead export(s) out of ${result.totalScanned} scanned:\n\n`;
		for (const item of result.dead) {
			output += `${item.file}:${item.line}  ${item.symbol}  (${item.kind})\n`;
		}
		return { content: [{ type: 'text', text: output }] };
	});

	server.tool('snapshot_workspace_code', `Saves or compares point-in-time snapshots of every workspace file (path, size, SHA-256).

WHEN TO USE: capture the workspace state before an automated edit session, then compare afterwards to review exactly what changed.

Snapshots live in .vscode-mcp/snapshots/ inside the workspace.`, {
		action: z.enum(['save', 'compare', 'list']).describe('save: create a snapshot. compare: diff current state against a baseline. list: show saved snapshots.'),
		name: z.string().optional().describe('Name for a new snapshot (save only)'),
		baseline: z.string().optional().describe('Name of the snapshot to compare against (compare only)')
	}, async ({ action, name, baseline }) => {
		const result = await snapshotWorkspace(action, name, baseline);
		return { content: [{ type: 'text', text: result }] };
	});

	server.tool('regex_tester_code', `Tests a regular expression against text or a file and reports every match with position and captured groups.

WHEN TO USE: debugging patterns before applying them, extracting data from logs, validating that a replace behaves as expected.`, {
		pattern: z.string().describe('The regular expression'),
		flags: z.string().optional().default('g').describe('Regex flags (default: g)'),
		text: z.string().optional().describe('Inline text to test against'),
		filePath: z.string().optional().describe('File to test against (used when text is not provided)'),
		replace: z.string().optional().describe('Optional replacement expression ($1, $<name> supported) — adds a preview of the replaced result')
	}, async ({ pattern, flags = 'g', text, filePath, replace }) => {
		const result = await testRegex(pattern, flags, text, filePath, replace);
		return { content: [{ type: 'text', text: result }] };
	});

	server.tool('convert_encoding_code', `Detects or converts the character encoding of a file using native Buffers.

WHEN TO USE: fixing files saved in the wrong encoding, adding or removing a BOM, normalizing sources to plain UTF-8.`, {
		path: z.string().describe('File to inspect or convert (relative to workspace root)'),
		action: z.enum(['detect', 'convert']).describe('detect: report the current encoding. convert: rewrite the file.'),
		from: z.enum(['utf-8', 'utf-8-bom', 'utf-16le', 'latin1']).optional().describe('Source encoding (convert only)'),
		to: z.enum(['utf-8', 'utf-8-bom', 'utf-16le', 'latin1']).optional().describe('Target encoding (convert only)')
	}, async ({ path: filePath, action, from, to }) => {
		if (action === 'detect') {
			const fullPath = await resolveWorkspaceFile(filePath);
			const detection = detectEncoding(fs.readFileSync(fullPath));
			return { content: [{ type: 'text', text: `${filePath}: ${detection}` }] };
		}
		if (!from || !to) {
			throw new Error('Both "from" and "to" encodings are required for convert');
		}
		const result = await handleEncodingConvert(filePath, from, to);
		return { content: [{ type: 'text', text: result }] };
	});
}
