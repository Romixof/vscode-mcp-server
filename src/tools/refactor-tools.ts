import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

const DEFAULT_EXCLUDES = [
	'**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.js',
	'**/*.map', '**/vendor/**', '**/.next/**', '**/target/**', '**/__pycache__/**'
];

const RENAME_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.php'];
const EXTRACT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'];
const DUPLICATE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.php'];
const ANALYZE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'];

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const SEPARATOR = String.fromCharCode(1);

const NUL = String.fromCharCode(0);

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

function collectFiles(rootDir: string, excludeRegexes: RegExp[]): Array<{ fullPath: string; relativePath: string }> {
	const files: Array<{ fullPath: string; relativePath: string }> = [];
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

function assertIdentifier(name: string, label: string): void {
	if (!IDENTIFIER_RE.test(name)) {
		throw new Error(`${label} "${name}" is not a valid identifier`);
	}
}

async function renameSymbol(options: {
	oldName: string;
	newName: string;
	dryRun: boolean;
	exclude?: string[];
	workspace?: string;
}): Promise<{ scanned: number; changed: Array<{ file: string; count: number }>; total: number }> {
	assertIdentifier(options.oldName, 'oldName');
	assertIdentifier(options.newName, 'newName');
	if (options.oldName === options.newName) {
		throw new Error('oldName and newName are identical');
	}

	const target = resolveRelativeToolPath('.', options.workspace);
	const workspaceRoot = target.root;
	const excludeRegexes = (options.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);
	const files = collectFiles(workspaceRoot, excludeRegexes)
		.filter(f => RENAME_EXTENSIONS.includes(path.extname(f.fullPath)));

	const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${options.oldName}(?![A-Za-z0-9_$])`, 'g');
	const changed: Array<{ file: string; count: number }> = [];
	let total = 0;

	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file.fullPath, 'utf-8');
		} catch {
			continue;
		}
		if (content.includes(NUL)) {
			continue;
		}
		const matches = content.match(wordRe);
		if (!matches || matches.length === 0) {
			continue;
		}
		if (!options.dryRun) {
			fs.writeFileSync(file.fullPath, content.replace(wordRe, options.newName));
		}
		changed.push({ file: `${target.displayBase}${file.relativePath}`, count: matches.length });
		total += matches.length;
	}

	return { scanned: files.length, changed, total };
}

async function extractFunction(options: {
	filePath: string;
	startLine: number;
	endLine: number;
	functionName: string;
	params: string[];
	workspace?: string;
}): Promise<string> {
	assertIdentifier(options.functionName, 'functionName');
	options.params.forEach(p => assertIdentifier(p, 'parameter'));

	const target = resolveRelativeToolPath(options.filePath, options.workspace);
	const absolutePath = target.fsPath;
	const ext = path.extname(absolutePath);
	if (!EXTRACT_EXTENSIONS.includes(ext)) {
		throw new Error(`Extraction supports ${EXTRACT_EXTENSIONS.join(', ')} files, got "${ext || 'extensionless file'}"`);
	}

	let content: string;
	try {
		content = fs.readFileSync(absolutePath, 'utf-8');
	} catch {
		throw new Error(`Cannot read ${options.filePath}`);
	}

	const lines = content.split('\n');
	const { startLine, endLine, functionName, params } = options;
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
		throw new Error(`Invalid line range ${startLine}-${endLine} (file has ${lines.length} line(s))`);
	}

	const isPython = ext === '.py';
	const baseIndent = (/^\s*/.exec(lines[startLine - 1]) || [''])[0];
	const dedented = lines.slice(startLine - 1, endLine)
		.map(l => l.startsWith(baseIndent) ? l.slice(baseIndent.length) : l.replace(/^\s+/, ''));

	const deeperIndent = dedented.map(l => (/^\s+/.exec(l) || [''])[0]).find(s => s.length > 0);
	const unit = isPython ? (deeperIndent || '    ') : '\t';
	const indentedBody = dedented.map(l => l.length > 0 ? unit + l : l);

	const paramList = params.join(', ');
	const callLine = isPython
		? `${baseIndent}${functionName}(${paramList})`
		: `${baseIndent}${functionName}(${paramList});`;

	const definition = isPython
		? ['', `def ${functionName}(${paramList}):`, ...indentedBody]
		: ['', `function ${functionName}(${paramList}) {`, ...indentedBody, '}'];

	const head = [...lines.slice(0, startLine - 1), callLine, ...lines.slice(endLine)]
		.join('\n')
		.replace(/\s*$/, '');

	fs.writeFileSync(absolutePath, `${head}\n${definition.join('\n')}\n`);

	const preview = [callLine, ...lines.slice(endLine, endLine + 2)]
		.map(l => l.length > 100 ? l.slice(0, 100) + '...' : l)
		.filter(l => l.trim() !== '')
		.join('\n');

	return [
		'# Extract Function',
		'',
		`Extracted ${endLine - startLine + 1} line(s) from ${options.filePath}:${startLine}-${endLine} into ${functionName}().`,
		`Call inserted at line ${startLine}, function appended at end of file.`,
		params.length > 0 ? `Parameters: ${paramList}` : 'No parameters.',
		'',
		'Review the result: return values and mutated locals are not wired automatically.',
		'',
		'Call site:',
		preview
	].join('\n');
}

function normalizeCodeLine(line: string): string | null {
	if (!line.trim()) {
		return null;
	}
	if (/^\s*(\/\/|#|\*|\/\*|<!--)/.test(line)) {
		return null;
	}
	return line.trim().replace(/\s+/g, ' ');
}

async function findDuplicates(options: {
	searchPath?: string;
	minLines: number;
	exclude?: string[];
	workspace?: string;
}): Promise<{ scanned: number; groups: Array<{ length: number; locations: Array<{ file: string; line: number }>; snippet: string[] }> }> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;
	const excludeRegexes = (options.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);

	interface Occurrence { file: string; line: number }

	const fileLines = new Map<string, Array<string | null>>();
	for (const file of collectFiles(rootDir, excludeRegexes)
		.filter(f => DUPLICATE_EXTENSIONS.includes(path.extname(f.fullPath)))) {
		try {
			const content = fs.readFileSync(file.fullPath, 'utf-8');
			if (content.includes(NUL)) {
				continue;
			}
			fileLines.set(file.relativePath, content.split('\n').map(normalizeCodeLine));
		} catch {
		}
	}

	const windows = new Map<string, Occurrence[]>();
	for (const [file, norms] of fileLines) {
		for (let i = 0; i + options.minLines <= norms.length; i++) {
			const chunk: string[] = [];
			let contiguous = true;
			for (let j = 0; j < options.minLines; j++) {
				const norm = norms[i + j];
				if (norm === null) {
					contiguous = false;
					break;
				}
				chunk.push(norm);
			}
			if (!contiguous) {
				continue;
			}
			const key = chunk.join(SEPARATOR);
			const list = windows.get(key) || [];
			list.push({ file, line: i + 1 });
			windows.set(key, list);
		}
	}

	const candidates = [...windows.entries()]
		.filter(([, occ]) => occ.length >= 2)
		.sort((a, b) => a[1][0].file.localeCompare(b[1][0].file) || a[1][0].line - b[1][0].line);

	const acceptedSpans = new Map<string, Array<[number, number]>>();
	const groups: Array<{ length: number; locations: Array<{ file: string; line: number }>; snippet: string[] }> = [];

	for (const [key, occ] of candidates) {
		const first = occ[0];
		const spans = acceptedSpans.get(first.file) || [];
		if (spans.some(([s, e]) => first.line >= s && first.line <= e)) {
			continue;
		}

		const normsA = fileLines.get(first.file)!;
		const second = occ.find(o => o.file !== first.file || o.line !== first.line)!;
		const normsB = fileLines.get(second.file)!;
		let length = options.minLines;
		while (
			length < 400 &&
			first.line - 1 + length < normsA.length &&
			second.line - 1 + length < normsB.length &&
			normsA[first.line - 1 + length] !== null &&
			normsA[first.line - 1 + length] === normsB[second.line - 1 + length]
		) {
			length++;
		}

		spans.push([first.line, first.line + length - 1]);
		acceptedSpans.set(first.file, spans);

		groups.push({
			length,
			locations: occ.slice(0, 5),
			snippet: key.split(SEPARATOR).slice(0, 3)
		});
		if (groups.length >= 20) {
			break;
		}
	}

	for (const group of groups) {
		for (const loc of group.locations) {
			loc.file = `${target.displayBase}${loc.file}`;
		}
	}
	return { scanned: fileLines.size, groups };
}

interface FuncStat {
	file: string;
	line: number;
	name: string;
	bodyLines: number;
	params: number;
	complexity: number;
	maxNest: number;
}

function jsFunctionStats(content: string, file: string): FuncStat[] {
	const stats: FuncStat[] = [];
	const decls = [
		/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g,
		/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=;\n]+)?=>/g
	];

	for (const decl of decls) {
		let m: RegExpExecArray | null;
		while ((m = decl.exec(content)) !== null) {
			const braceIdx = content.indexOf('{', m.index + m[0].length - 1);
			if (braceIdx === -1) {
				continue;
			}
			let depth = 0;
			let end = -1;
			let maxNest = 0;
			for (let i = braceIdx; i < content.length; i++) {
				if (content[i] === '{') {
					depth++;
					maxNest = Math.max(maxNest, depth - 1);
				} else if (content[i] === '}') {
					depth--;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
			if (end === -1) {
				continue;
			}
			const body = content.slice(braceIdx + 1, end);
			stats.push({
				file,
				line: content.slice(0, m.index).split('\n').length,
				name: m[1],
				bodyLines: body.split('\n').length,
				params: m[2].trim() ? m[2].split(',').length : 0,
				complexity: (body.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?[^.:\s]/g) || []).length,
				maxNest
			});
		}
	}
	return stats;
}

function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === '\t') {
			width += 4;
		} else if (ch === ' ') {
			width += 1;
		} else {
			break;
		}
	}
	return width;
}

function pythonFunctionStats(content: string, file: string): FuncStat[] {
	const stats: FuncStat[] = [];
	const lines = content.split('\n');
	const declRe = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;

	for (let i = 0; i < lines.length; i++) {
		const m = declRe.exec(lines[i]);
		if (!m) {
			continue;
		}
		const defWidth = indentWidth(m[1]);

		let end = i + 1;
		while (end < lines.length) {
			const line = lines[end];
			if (line.trim() === '' || indentWidth(line) > defWidth) {
				end++;
				continue;
			}
			break;
		}

		const body = lines.slice(i + 1, end).filter(l => l.trim() !== '');
		const params = m[3].trim() ? m[3].split(',') : [];
		if (params.length && /^(self|cls)$/.test(params[0].trim())) {
			params.shift();
		}

		stats.push({
			file,
			line: i + 1,
			name: m[2],
			bodyLines: body.length,
			params: params.length,
			complexity: (body.join('\n').match(/\b(if|elif|for|while|except|and|or)\b/g) || []).length,
			maxNest: body.reduce((max, l) => Math.max(max, Math.round((indentWidth(l) - defWidth) / 4)), 0)
		});
	}
	return stats;
}

async function suggestRefactoring(options: {
	searchPath?: string;
	maxLines: number;
	maxParams: number;
	maxComplexity: number;
	workspace?: string;
}): Promise<{ scannedFunctions: number; flagged: Array<FuncStat & { reasons: string[] }> }> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;
	const excludeRegexes = DEFAULT_EXCLUDES.map(globToRegExp);
	const files = collectFiles(rootDir, excludeRegexes)
		.filter(f => ANALYZE_EXTENSIONS.includes(path.extname(f.fullPath)));

	const all: FuncStat[] = [];
	for (const file of files) {
		try {
			const content = fs.readFileSync(file.fullPath, 'utf-8');
			if (content.includes(NUL)) {
				continue;
			}
			all.push(...(path.extname(file.fullPath) === '.py'
				? pythonFunctionStats(content, file.relativePath)
				: jsFunctionStats(content, file.relativePath)));
		} catch {
		}
	}

	const flagged = all.map(stat => {
		const reasons: string[] = [];
		if (stat.bodyLines > options.maxLines) {
			reasons.push(`${stat.bodyLines} lines long — split it up`);
		}
		if (stat.params > options.maxParams) {
			reasons.push(`${stat.params} parameters — consider grouping them`);
		}
		if (stat.complexity > options.maxComplexity) {
			reasons.push(`complexity ~${stat.complexity} — extract conditional logic`);
		}
		if (stat.maxNest > 4) {
			reasons.push(`nesting depth ${stat.maxNest} — use early returns`);
		}
		return { ...stat, reasons };
	})
		.filter(s => s.reasons.length > 0)
		.sort((a, b) => b.reasons.length - a.reasons.length || b.bodyLines - a.bodyLines)
		.slice(0, 30);

	for (const stat of flagged) {
		stat.file = `${target.displayBase}${stat.file}`;
	}
	return { scannedFunctions: all.length, flagged };
}

export function registerRefactorTools(server: McpServer): void {
	server.tool('rename_symbol_code', `Renames a symbol (variable, function, class) across every code file in the workspace using word-boundary matching.

WHEN TO USE: safe textual rename when the editor's built-in rename cannot be driven remotely.

Pass dryRun=true first to preview how many occurrences change per file. Partial words are never touched (renaming "count" leaves "totalCount" alone).`, {
		oldName: z.string().describe('Current identifier name'),
		newName: z.string().describe('New identifier name'),
		dryRun: z.boolean().optional().default(false).describe('Preview the rename without writing files'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ oldName, newName, dryRun = false, exclude, workspace }) => {
		const result = await renameSymbol({ oldName, newName, dryRun, exclude, workspace });
		if (result.total === 0) {
			return { content: [{ type: 'text', text: `No occurrences of "${oldName}" found in ${result.scanned} scanned file(s).` }] };
		}
		let text = `# Rename ${oldName} -> ${newName}\n\n${dryRun ? 'Would rename' : 'Renamed'} ${result.total} occurrence(s) in ${result.changed.length} file(s):\n\n`;
		for (const c of result.changed) {
			text += `- ${c.file}: ${c.count}\n`;
		}
		if (dryRun) {
			text += '\nDry run — call again with dryRun=false to apply.';
		}
		return { content: [{ type: 'text', text }] };
	});

	server.tool('extract_function_code', `Extracts a line range from a file into a new function and replaces the range with a call to it.

WHEN TO USE: splitting up a long function once you have decided which lines belong together and which variables they need.

You supply the parameter names explicitly — locals are not analysed, so review that the result compiles afterwards. Works on JavaScript/TypeScript and Python files.`, {
		path: z.string().describe('File to edit'),
		startLine: z.number().int().min(1).describe('First line to extract (1-based)'),
		endLine: z.number().int().min(1).describe('Last line to extract (inclusive)'),
		functionName: z.string().describe('Name for the new function'),
		params: z.array(z.string()).optional().default([]).describe('Parameter names for the new function'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: filePath, startLine, endLine, functionName, params = [], workspace }) => {
		const text = await extractFunction({ filePath, startLine, endLine, functionName, params, workspace });
		return { content: [{ type: 'text', text }] };
	});

	server.tool('find_duplicate_code_code', `Finds repeated code blocks across the workspace: normalised sliding windows of consecutive lines are hashed, and blocks appearing two or more times are reported with all their locations.

WHEN TO USE: before refactoring, hunting copy-pasted logic, deciding what deserves extraction into a shared helper.

Comment-only and empty lines never break or join a block.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		minLines: z.number().int().min(3).max(50).optional().default(5).describe('Block size in consecutive code lines (default 5)'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, minLines = 5, exclude, workspace }) => {
		const result = await findDuplicates({ searchPath, minLines, exclude, workspace });
		if (result.groups.length === 0) {
			return { content: [{ type: 'text', text: `No duplicate blocks of >= ${minLines} lines found across ${result.scanned} file(s).` }] };
		}
		let text = `# Duplicate Code\n\nFound ${result.groups.length} duplicate block(s) of >= ${minLines} lines:\n\n`;
		result.groups.forEach((g, i) => {
			text += `## Block ${i + 1} — ${g.length} line(s), ${g.locations.length} location(s)\n`;
			for (const loc of g.locations) {
				text += `\t${loc.file}:${loc.line}\n`;
			}
			text += `\t| ${g.snippet.join('\n\t| ')}\n\n`;
		});
		return { content: [{ type: 'text', text }] };
	});

	server.tool('suggest_refactoring_code', `Flags functions worth refactoring with concrete numbers: body length, parameter count, approximate cyclomatic complexity, nesting depth. Heuristic static analysis, nothing is executed.

WHEN TO USE: deciding where to start cleaning up a file or module, reviewing AI-generated code that grew too big.`, {
		path: z.string().optional().describe('File or subdirectory to analyse (default: whole workspace)'),
		maxLines: z.number().int().min(10).optional().default(80).describe('Flag functions longer than this many lines'),
		maxParams: z.number().int().min(1).optional().default(4).describe('Flag functions with more than this many parameters'),
		maxComplexity: z.number().int().min(1).optional().default(10).describe('Flag functions above this complexity estimate'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, maxLines = 80, maxParams = 4, maxComplexity = 10, workspace }) => {
		const result = await suggestRefactoring({ searchPath, maxLines, maxParams, maxComplexity, workspace });
		if (result.flagged.length === 0) {
			return { content: [{ type: 'text', text: `No refactoring candidates among ${result.scannedFunctions} function(s) scanned.` }] };
		}
		let text = `# Refactoring Suggestions\n\n${result.flagged.length} of ${result.scannedFunctions} function(s) flagged:\n\n`;
		for (const f of result.flagged) {
			text += `[${f.file}:${f.line}] ${f.name} — ${f.bodyLines} lines, ${f.params} params, complexity ~${f.complexity}, depth ${f.maxNest}\n`;
			for (const reason of f.reasons) {
				text += `\t- ${reason}\n`;
			}
		}
		return { content: [{ type: 'text', text }] };
	});
}
