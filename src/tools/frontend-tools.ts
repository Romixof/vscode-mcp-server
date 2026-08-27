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

const MARKUP_EXTENSIONS = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.php'];
const STYLE_EXTENSIONS = ['.css'];

const TOKEN_EXTENSIONS = [...MARKUP_EXTENSIONS, '.js', '.ts', '.mjs', '.cjs'];

interface Finding {
	severity: 'high' | 'medium' | 'low';
	kind: string;
	file: string;
	line: number;
	snippet: string;
}

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

function collectFiles(rootDir: string, excludeRegexes: RegExp[], extensions?: string[]): Array<{ fullPath: string; relativePath: string }> {
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
			} else if (entry.isFile() && (!extensions || extensions.includes(path.extname(fullPath)))) {
				files.push({ fullPath, relativePath });
			}
		}
	}
	walk(rootDir);
	return files;
}

const NUL = String.fromCharCode(0);

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, '');
}

function formatFindings(title: string, scanned: number, findings: Finding[]): string {
	const counts = { high: 0, medium: 0, low: 0 };
	for (const f of findings) {
		counts[f.severity] += 1;
	}
	if (findings.length === 0) {
		return `${title}\n\nNo issues found across ${scanned} file(s).`;
	}
	let output = `${title}\n\nScanned ${scanned} file(s). Findings: ${findings.length} (high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low})\n\n`;
	for (const f of findings.slice(0, 60)) {
		output += `[${f.severity.toUpperCase()}] ${f.kind} — ${f.file}:${f.line}\n    ${f.snippet}\n`;
	}
	if (findings.length > 60) {
		output += `... and ${findings.length - 60} more\n`;
	}
	return output;
}

interface A11yRule {
	kind: string;
	severity: 'high' | 'medium' | 'low';
	regex: RegExp;
	skip?: (tagText: string) => boolean;
}

const A11Y_RULES: A11yRule[] = [
	{ kind: 'img-without-alt', severity: 'medium', regex: /<img\b(?![^>]*\balt\s*=)[^>]*>/gi },
	{ kind: 'html-without-lang', severity: 'low', regex: /<html\b(?![^>]*\blang\s*=)[^>]*>/gi },
	{
		kind: 'positive-tabindex', severity: 'low',
		regex: /\btabindex\s*=\s*["']?(\d+)["']?/gi,
		skip: tagText => parseInt((/\btabindex\s*=\s*["']?(\d+)/i.exec(tagText) || [])[1] || '0', 10) <= 0
	},
	{ kind: 'clickable-div-or-span', severity: 'medium', regex: /<(?:div|span)\b[^>]*\bonclick\s*=/gi },
	{
		kind: 'input-without-label', severity: 'medium',
		regex: /<input\b(?![^>]*\b(?:aria-label|aria-labelledby|id)\s*=)[^>]*>/gi,
		skip: tagText => /\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(tagText)
	},
	{ kind: 'empty-link', severity: 'medium', regex: /<a\b[^>]*>\s*<\/a\s*>/gi }
];

async function auditAccessibility(options: {
	searchPath?: string;
	exclude?: string[];
	workspace?: string;
}): Promise<{ scanned: number; findings: Finding[] }> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;
	const excludeRegexes = (options.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);
	const files = collectFiles(rootDir, excludeRegexes, MARKUP_EXTENSIONS);

	const findings: Finding[] = [];
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
		const clean = stripHtmlComments(content);
		const lineStarts: number[] = [0];
		for (let i = 0; i < clean.length; i++) {
			if (clean[i] === '\n') {
				lineStarts.push(i + 1);
			}
		}

		for (const rule of A11Y_RULES) {
			rule.regex.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = rule.regex.exec(clean)) !== null) {
				if (rule.skip && rule.skip(m[0])) {
					continue;
				}
				let line = 1;
				while (line < lineStarts.length && lineStarts[line] <= m.index) {
					line++;
				}
				findings.push({
					severity: rule.severity,
					kind: rule.kind,
					file: `${target.displayPrefix}${file.relativePath}`,
					line,
					snippet: m[0].replace(/\s+/g, ' ').trim().slice(0, 120)
				});
			}
		}
	}

	findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	return { scanned: files.length, findings };
}

interface CssRule {
	file: string;
	selector: string;
	body: string;
	line: number;
	fullPath: string;
}

function parseCssFile(content: string, file: { fullPath: string; relativePath: string }): CssRule[] {
	const rules: CssRule[] = [];
	const lineAt = (idx: number) => content.slice(0, idx).split('\n').length;

	function parseSegment(from: number, to: number): void {
		let buffer = '';
		let i = from;
		while (i < to) {
			const ch = content[i];
			if (ch === '{') {
				const selector = buffer.trim();
				let depth = 1;
				let j = i + 1;
				while (j < to && depth > 0) {
					if (content[j] === '{') {
						depth++;
					} else if (content[j] === '}') {
						depth--;
					}
					j++;
				}
				const closeIdx = Math.max(i + 1, j - 1);
				rules.push({ file: file.relativePath, selector, body: content.slice(i + 1, closeIdx), line: lineAt(i), fullPath: file.fullPath });

				parseSegment(i + 1, closeIdx);
				buffer = '';
				i = j;
			} else if (ch === '}') {
				buffer = '';
				i++;
			} else {
				buffer += ch;
				i++;
			}
		}
	}

	parseSegment(0, content.length);
	return rules;
}

function loadCssRules(rootDir: string, excludeRegexes: RegExp[]): CssRule[] {
	const rules: CssRule[] = [];
	for (const file of collectFiles(rootDir, excludeRegexes, STYLE_EXTENSIONS)) {
		try {
			const content = fs.readFileSync(file.fullPath, 'utf-8');
			if (!content.includes(NUL)) {
				rules.push(...parseCssFile(content, file));
			}
		} catch {
		}
	}
	return rules;
}

async function analyzeCss(options: { searchPath?: string; workspace?: string }): Promise<{ scanned: number; findings: Finding[] }> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;
	const excludeRegexes = DEFAULT_EXCLUDES.map(globToRegExp);

	const cssFiles = collectFiles(rootDir, excludeRegexes, STYLE_EXTENSIONS);
	const rulesByFile = new Map<string, CssRule[]>();
	for (const rule of loadCssRules(rootDir, excludeRegexes)) {
		const list = rulesByFile.get(rule.file) || [];
		list.push(rule);
		rulesByFile.set(rule.file, list);
	}

	const findings: Finding[] = [];

	for (const [file, rules] of rulesByFile) {
		const seenSelectors = new Map<string, number[]>();
		for (const rule of rules) {
			const norm = rule.selector.toLowerCase().replace(/\s+/g, ' ');
			if (!norm || norm.startsWith('@')) {
				continue;
			}
			const lines = seenSelectors.get(norm) || [];
			lines.push(rule.line);
			seenSelectors.set(norm, lines);
		}
		for (const [selector, lines] of seenSelectors) {
			if (lines.length >= 2) {
				findings.push({
					severity: 'medium',
					kind: 'duplicate-selector',
					file,
					line: lines[0],
					snippet: `"${selector}" defined ${lines.length} time(s) (lines ${lines.slice(0, 5).join(', ')})`
				});
			}
		}

		for (const rule of rules) {
			if (rule.body.trim() === '') {
				findings.push({ severity: 'low', kind: 'empty-rule', file, line: rule.line, snippet: `${rule.selector} { }` });
				continue;
			}
			const propCounts = new Map<string, number>();
			for (const decl of rule.body.split(';')) {
				const pm = /^\s*([-\w]+)\s*:/.exec(decl);
				if (pm) {
					propCounts.set(pm[1].toLowerCase(), (propCounts.get(pm[1].toLowerCase()) || 0) + 1);
				}
			}
			for (const [prop, count] of propCounts) {
				if (count > 1) {
					findings.push({
						severity: 'medium',
						kind: 'duplicate-property',
						file,
						line: rule.line,
						snippet: `"${prop}" set ${count} time(s) in "${rule.selector}" — only the last wins`
					});
				}
			}
		}

		const importantCount = (rules.map(r => r.body.match(/!important/g) || []).flat()).length;
		if (importantCount > 10) {
			findings.push({
				severity: 'low',
				kind: 'important-overuse',
				file,
				line: 1,
				snippet: `!important used ${importantCount} time(s) — specificity fights ahead`
			});
		}
	}

	findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	for (const finding of findings) {
		finding.file = `${target.displayBase}${finding.file}`;
	}
	return { scanned: cssFiles.length, findings };
}

async function inspectElement(options: {
	selector: string;
	searchPath?: string;
	workspace?: string;
}): Promise<string> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;

	let kind: 'class' | 'id' | 'tag';
	let name: string;
	if (options.selector.startsWith('.')) {
		kind = 'class';
		name = options.selector.slice(1);
	} else if (options.selector.startsWith('#')) {
		kind = 'id';
		name = options.selector.slice(1);
	} else if (/^[A-Za-z][\w-]*$/.test(options.selector)) {
		kind = 'tag';
		name = options.selector.toLowerCase();
	} else {
		throw new Error(`Unsupported selector "${options.selector}" — use ".class", "#id" or a plain tag name`);
	}
	if (!/^[\w-]+$/.test(name)) {
		throw new Error(`Unsupported selector "${options.selector}"`);
	}

	const excludeRegexes = DEFAULT_EXCLUDES.map(globToRegExp);
	interface Usage { file: string; line: number; text: string }
	const usages: Usage[] = [];

	for (const file of collectFiles(rootDir, excludeRegexes, MARKUP_EXTENSIONS)) {
		let content: string;
		try {
			content = stripHtmlComments(fs.readFileSync(file.fullPath, 'utf-8'));
		} catch {
			continue;
		}
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			let hit = false;
			if (kind === 'class') {
				const attrRe = /(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
				let am: RegExpExecArray | null;
				while ((am = attrRe.exec(lines[i])) !== null) {
					const tokens = (am[1] ?? am[2] ?? '').split(/\s+/);
					if (tokens.includes(name)) {
						hit = true;
					}
				}
			} else if (kind === 'id') {
				const idRe = /\bid\s*=\s*["']([^"']*)["']/g;
				let im: RegExpExecArray | null;
				while ((im = idRe.exec(lines[i])) !== null) {
					if (im[1].trim() === name) {
						hit = true;
					}
				}
			} else {
				const tagRe = /<([A-Za-z][\w-]*)/g;
				let tm: RegExpExecArray | null;
				while ((tm = tagRe.exec(lines[i])) !== null) {
					if (tm[1].toLowerCase() === name) {
						hit = true;
					}
				}
			}
			if (hit && usages.length < 20) {
				usages.push({ file: `${target.displayPrefix}${file.relativePath}`, line: i + 1, text: lines[i].trim().slice(0, 120) });
			}
		}
	}

	const cssRules = loadCssRules(rootDir, excludeRegexes).filter(rule =>
		rule.selector.split(',').some(part => {
			const trimmed = part.trim();
			return kind === 'class'
				? new RegExp(`\\.(${name})(?![-\\w])`).test(trimmed)
				: kind === 'id'
					? new RegExp(`#(${name})(?![-\\w])`).test(trimmed)
					: new RegExp(`^${name}(?![-\\w])`, 'i').test(trimmed);
		})
	);

	let text = `# Element Inspection: ${options.selector}\n\n`;
	if (usages.length === 0) {
		text += `No markup usage found for this ${kind}.\n\n`;
	} else {
		text += `Markup usages (${usages.length}):\n`;
		for (const u of usages) {
			text += `\t${u.file}:${u.line}\n\t    ${u.text}\n`;
		}
		text += '\n';
	}
	if (cssRules.length === 0) {
		text += 'No matching CSS rules.';
	} else {
		text += `CSS rules (${cssRules.length}):\n`;
		for (const r of cssRules.slice(0, 10)) {
			text += `\t${r.selector}  (${target.displayBase}${r.file}:${r.line})\n\t    ${r.body.replace(/\s+/g, ' ').trim().slice(0, 200)}\n`;
		}
		if (cssRules.length > 10) {
			text += `\t... and ${cssRules.length - 10} more\n`;
		}
	}
	return text;
}

async function findUnusedCss(options: { searchPath?: string; workspace?: string }): Promise<string> {
	const target = resolveRelativeToolPath(options.searchPath ?? '.', options.workspace);
	const rootDir = target.dir;
	const excludeRegexes = DEFAULT_EXCLUDES.map(globToRegExp);

	interface Def { type: 'class' | 'id'; file: string; line: number }
	const defined = new Map<string, Def>();

	for (const rule of loadCssRules(rootDir, excludeRegexes)) {
		for (const part of rule.selector.split(',')) {
			const selRe = /\.(-?[A-Za-z_][\w-]*)|#(-?[A-Za-z_][\w-]*)/g;
			let sm: RegExpExecArray | null;
			while ((sm = selRe.exec(part)) !== null) {
				const name = sm[1] ?? sm[2];
				if (name && !defined.has(name)) {
					defined.set(name, { type: sm[1] ? 'class' : 'id', file: rule.file, line: rule.line });
				}
			}
		}
	}

	const usedTokens = new Set<string>();
	for (const file of collectFiles(rootDir, excludeRegexes, TOKEN_EXTENSIONS)) {
		let content: string;
		try {
			content = fs.readFileSync(file.fullPath, 'utf-8');
		} catch {
			continue;
		}
		if (content.includes(NUL)) {
			continue;
		}
		const strRe = /["']([^"'\n]{1,200})["']/g;
		let qm: RegExpExecArray | null;
		while ((qm = strRe.exec(content)) !== null) {
			for (const token of qm[1].match(/[\w-]+/g) || []) {
				usedTokens.add(token);
			}
		}

		const tplRe = /`([^`\n]{1,400})`/g;
		let tm: RegExpExecArray | null;
		while ((tm = tplRe.exec(content)) !== null) {
			for (const token of tm[1].match(/[\w-]+/g) || []) {
				usedTokens.add(token);
			}
		}
	}

	const unused: Array<{ name: string; def: Def }> = [];
	for (const [name, def] of defined) {
		if (!usedTokens.has(name)) {
			unused.push({ name, def });
		}
	}
	unused.sort((a, b) => a.def.file.localeCompare(b.def.file) || a.def.line - b.def.line);

	if (unused.length === 0) {
		return `# Unused CSS\n\nAll ${defined.size} class/id selector(s) are referenced somewhere.`;
	}
	let text = `# Unused CSS\n\n${unused.length} of ${defined.size} selector(s) never appear in any markup or script string:\n\n`;
	for (const u of unused.slice(0, 50)) {
		text += `- ${u.def.type === 'class' ? '.' : '#'}${u.name} (${target.displayBase}${u.def.file}:${u.def.line})\n`;
	}
	if (unused.length > 50) {
		text += `... and ${unused.length - 50} more\n`;
	}
	return text;
}

export function registerFrontendTools(server: McpServer): void {
	server.tool('audit_accessibility_code', `Audit HTML/JSX for a11y issues.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, exclude, workspace }) => {
		const result = await auditAccessibility({ searchPath, exclude, workspace });
		return { content: [{ type: 'text', text: formatFindings('# Accessibility Audit', result.scanned, result.findings) }] };
	});

	server.tool('analyze_css_code', `Analyze CSS quality (dupes, specificity).`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, workspace }) => {
		const result = await analyzeCss({ searchPath, workspace });
		return { content: [{ type: 'text', text: formatFindings('# CSS Analysis', result.scanned, result.findings) }] };
	});

	server.tool('inspect_element_code', `Find where a CSS selector is used.`, {
		selector: z.string().describe('Selector to inspect, e.g. ".btn", "#app" or "nav"'),
		path: z.string().optional().describe('Subdirectory to search (default: whole workspace)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ selector, path: searchPath, workspace }) => {
		const text = await inspectElement({ selector, searchPath, workspace });
		return { content: [{ type: 'text', text }] };
	});

	server.tool('find_unused_css_code', `Find unused CSS selectors.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, workspace }) => {
		const text = await findUnusedCss({ searchPath, workspace });
		return { content: [{ type: 'text', text }] };
	});
}
