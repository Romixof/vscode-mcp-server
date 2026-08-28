import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import { resolveWorkspaceFolder, resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeShellCommand } from './shell-tools';

interface DependencyEntry {
	name: string;
	version: string;
	type: 'production' | 'development' | 'peer' | 'optional';
	ecosystem: string;
	source: string;
}

interface EcosystemDependencies {
	ecosystem: string;
	manager: string;
	manifestPath: string;
	lockfilePath?: string;
	dependencies: DependencyEntry[];
	totalCount: number;
	devCount: number;
	prodCount: number;
	outdatedCount: number;
}

interface TodoMatch {
	file: string;
	line: number;
	column: number;
	tag: string;
	text: string;
	context: {
		before: string[];
		after: string[];
	};
	severity: 'high' | 'medium' | 'low';
}

interface TodoStats {
	total: number;
	byTag: Record<string, number>;
	byFile: Record<string, number>;
	bySeverity: { high: number; medium: number; low: number };
}

interface TodoOptions {
	patterns?: string[];
	customPatterns?: string[];
	path?: string;
	include?: string[];
	exclude?: string[];
	caseSensitive?: boolean;
	contextLines?: number;
	format?: string;
	groupBy?: string;
	workspace?: string;
}

interface FileHistoryCommit {
	hash: string;
	shortHash: string;
	author: { name: string; email: string };
	date: string;
	message: string;
	stats?: { files: number; insertions: number; deletions: number };
	diff?: string;
}

async function getWorkspaceRoot(ref?: string): Promise<string> {
	return resolveWorkspaceFolder(ref).uri.fsPath;
}

function getTerminal(): vscode.Terminal {
	return vscode.window.activeTerminal || vscode.window.createTerminal('MCP Documentation');
}

async function runCommand(command: string, cwd?: string): Promise<{ output: string; exitCode: number }> {
	const terminal = getTerminal();
	const workspaceRoot = cwd || await getWorkspaceRoot();
	try {
		const { output } = await executeShellCommand(terminal, command, workspaceRoot, 60000);
		return { output, exitCode: 0 };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const exitCodeMatch = errorMessage.match(/exit code (\d+)/i);
		const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 1;
		return { output: errorMessage, exitCode };
	}
}

async function readJsonFile<T = any>(filePath: string): Promise<T | null> {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function readTextFile(filePath: string): Promise<string | null> {
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

function parsePackageJson(content: any, manifestPath: string): EcosystemDependencies[] {
	const deps: Record<string, string> = content.dependencies || {};
	const devDeps: Record<string, string> = content.devDependencies || {};
	const peerDeps: Record<string, string> = content.peerDependencies || {};
	const optionalDeps: Record<string, string> = content.optionalDependencies || {};

	const allDeps: DependencyEntry[] = [];
	for (const [name, version] of Object.entries(deps)) {
		allDeps.push({ name, version, type: 'production', ecosystem: 'npm', source: 'package.json' });
	}
	for (const [name, version] of Object.entries(devDeps)) {
		allDeps.push({ name, version, type: 'development', ecosystem: 'npm', source: 'package.json' });
	}
	for (const [name, version] of Object.entries(peerDeps)) {
		allDeps.push({ name, version, type: 'peer', ecosystem: 'npm', source: 'package.json' });
	}
	for (const [name, version] of Object.entries(optionalDeps)) {
		allDeps.push({ name, version, type: 'optional', ecosystem: 'npm', source: 'package.json' });
	}

	return [{
		ecosystem: 'node',
		manager: 'npm',
		manifestPath,
		lockfilePath: manifestPath.replace('package.json', 'package-lock.json'),
		dependencies: allDeps,
		totalCount: allDeps.length,
		devCount: Object.keys(devDeps).length,
		prodCount: Object.keys(deps).length,
		outdatedCount: 0
	}];
}

async function getNodeDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const packageJsonPath = path.join(workspaceRoot, 'package.json');
	const content = await readJsonFile(packageJsonPath);
	if (!content) {
		return [];
	}
	return parsePackageJson(content, packageJsonPath);
}

async function getPythonDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const results: EcosystemDependencies[] = [];
	const files = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'poetry.lock', 'setup.py', 'setup.cfg'];

	for (const file of files) {
		const filePath = path.join(workspaceRoot, file);
		const content = await readTextFile(filePath);
		if (!content) {
			continue;
		}

		const deps: DependencyEntry[] = [];

		if (file === 'requirements.txt' || file === 'requirements-dev.txt') {
			for (const line of content.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
					continue;
				}
				const match = trimmed.match(/^([a-zA-Z0-9_.-]+)([=<>!~]+.*)?/);
				if (match) {
					deps.push({
						name: match[1],
						version: match[2]?.replace(/^[=<>!~]+/, '') || 'latest',
						type: file.includes('dev') ? 'development' : 'production',
						ecosystem: 'pypi',
						source: file
					});
				}
			}
		} else if (file === 'pyproject.toml') {
			const poetryMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
			if (poetryMatch) {
				for (const line of poetryMatch[1].split('\n')) {
					const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*=\s*["']?([^"'\s]+)["']?/);
					if (match && match[1] !== 'python') {
						deps.push({ name: match[1], version: match[2], type: 'production', ecosystem: 'pypi', source: 'pyproject.toml' });
					}
				}
			}
			const poetryDevMatch = content.match(/\[tool\.poetry\.group\.dev\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
			if (poetryDevMatch) {
				for (const line of poetryDevMatch[1].split('\n')) {
					const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*=\s*["']?([^"'\s]+)["']?/);
					if (match) {
						deps.push({ name: match[1], version: match[2], type: 'development', ecosystem: 'pypi', source: 'pyproject.toml' });
					}
				}
			}
		} else if (file === 'Pipfile') {
			const packagesMatch = content.match(/\[packages\]([\s\S]*?)(?=\n\[|$)/);
			if (packagesMatch) {
				for (const line of packagesMatch[1].split('\n')) {
					const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*=\s*["']?([^"'\s]+)["']?/);
					if (match) {
						deps.push({ name: match[1], version: match[2], type: 'production', ecosystem: 'pypi', source: 'Pipfile' });
					}
				}
			}
			const devPackagesMatch = content.match(/\[dev-packages\]([\s\S]*?)(?=\n\[|$)/);
			if (devPackagesMatch) {
				for (const line of devPackagesMatch[1].split('\n')) {
					const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*=\s*["']?([^"'\s]+)["']?/);
					if (match) {
						deps.push({ name: match[1], version: match[2], type: 'development', ecosystem: 'pypi', source: 'Pipfile' });
					}
				}
			}
		}

		if (deps.length > 0) {
			results.push({
				ecosystem: 'python',
				manager: file === 'poetry.lock' ? 'poetry' : file === 'Pipfile' ? 'pipenv' : 'pip',
				manifestPath: filePath,
				dependencies: deps,
				totalCount: deps.length,
				devCount: deps.filter(d => d.type === 'development').length,
				prodCount: deps.filter(d => d.type === 'production').length,
				outdatedCount: 0
			});
		}
	}

	return results;
}

async function getRustDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const cargoTomlPath = path.join(workspaceRoot, 'Cargo.toml');
	const content = await readTextFile(cargoTomlPath);
	if (!content) {
		return [];
	}

	const deps: DependencyEntry[] = [];
	const depSections = ['dependencies', 'dev-dependencies', 'build-dependencies'];

	for (const section of depSections) {

		const regex = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i');
		const match = content.match(regex);
		if (!match) {
			continue;
		}
		for (const line of match[1].split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}
			const parts = trimmed.split('=');
			if (parts.length < 2) {
				continue;
			}
			const name = parts[0].trim();
			let version = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
			if (version.startsWith('{')) {

				const versionMatch = version.match(/version\s*=\s*["']([^"']+)["']/);
				version = versionMatch ? versionMatch[1] : '*';
			}
			deps.push({
				name,
				version,
				type: section.includes('dev') ? 'development' : section.includes('build') ? 'optional' : 'production',
				ecosystem: 'crates.io',
				source: 'Cargo.toml'
			});
		}
	}

	if (deps.length === 0) {
		return [];
	}

	return [{
		ecosystem: 'rust',
		manager: 'cargo',
		manifestPath: cargoTomlPath,
		lockfilePath: path.join(workspaceRoot, 'Cargo.lock'),
		dependencies: deps,
		totalCount: deps.length,
		devCount: deps.filter(d => d.type === 'development').length,
		prodCount: deps.filter(d => d.type === 'production').length,
		outdatedCount: 0
	}];
}

async function getGoDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const goModPath = path.join(workspaceRoot, 'go.mod');
	const content = await readTextFile(goModPath);
	if (!content) {
		return [];
	}

	const deps: DependencyEntry[] = [];
	const requireMatch = content.match(/require\s*\(([\s\S]*?)\)/);
	if (requireMatch) {
		for (const line of requireMatch[1].split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('//')) {
				continue;
			}
			const parts = trimmed.split(/\s+/);
			if (parts.length >= 2) {
				deps.push({
					name: parts[0],
					version: parts[1],
					type: 'production',
					ecosystem: 'go',
					source: 'go.mod'
				});
			}
		}
	}

	if (deps.length === 0) {
		return [];
	}

	return [{
		ecosystem: 'go',
		manager: 'go modules',
		manifestPath: goModPath,
		lockfilePath: path.join(workspaceRoot, 'go.sum'),
		dependencies: deps,
		totalCount: deps.length,
		devCount: 0,
		prodCount: deps.length,
		outdatedCount: 0
	}];
}

async function getPhpDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const composerPath = path.join(workspaceRoot, 'composer.json');
	const content = await readJsonFile(composerPath);
	if (!content) {
		return [];
	}

	const deps: DependencyEntry[] = [];
	const prodRequires: Record<string, string> = content.require || {};
	const devRequires: Record<string, string> = content['require-dev'] || {};

	for (const [name, version] of Object.entries(prodRequires)) {
		if (name !== 'php' && !name.startsWith('ext-')) {
			deps.push({ name, version, type: 'production', ecosystem: 'packagist', source: 'composer.json' });
		}
	}
	for (const [name, version] of Object.entries(devRequires)) {
		deps.push({ name, version, type: 'development', ecosystem: 'packagist', source: 'composer.json' });
	}

	if (deps.length === 0) {
		return [];
	}

	return [{
		ecosystem: 'php',
		manager: 'composer',
		manifestPath: composerPath,
		lockfilePath: path.join(workspaceRoot, 'composer.lock'),
		dependencies: deps,
		totalCount: deps.length,
		devCount: Object.keys(devRequires).length,
		prodCount: Object.keys(prodRequires).length,
		outdatedCount: 0
	}];
}

async function getRubyDependencies(workspaceRoot: string): Promise<EcosystemDependencies[]> {
	const gemfilePath = path.join(workspaceRoot, 'Gemfile');
	const content = await readTextFile(gemfilePath);
	if (!content) {
		return [];
	}

	const deps: DependencyEntry[] = [];
	let inGroup = false;
	let currentGroup = 'production';

	for (const rawLine of content.split('\n')) {
		const trimmed = rawLine.trim();
		if (trimmed.startsWith('group ')) {
			inGroup = true;
			const match = trimmed.match(/group\s+[:](\w+)/);
			currentGroup = match ? match[1] : 'development';
		} else if (trimmed === 'end' && inGroup) {
			inGroup = false;
			currentGroup = 'production';
		} else if (trimmed.startsWith('gem ')) {
			const match = trimmed.match(/gem\s+['"]([^'"]+)['"]\s*,?\s*['"]?([^'"]*)['"]?/);
			if (match) {
				deps.push({
					name: match[1],
					version: match[2] || 'latest',
					type: currentGroup === 'production' ? 'production' : 'development',
					ecosystem: 'rubygems',
					source: 'Gemfile'
				});
			}
		}
	}

	if (deps.length === 0) {
		return [];
	}

	return [{
		ecosystem: 'ruby',
		manager: 'bundler',
		manifestPath: gemfilePath,
		lockfilePath: path.join(workspaceRoot, 'Gemfile.lock'),
		dependencies: deps,
		totalCount: deps.length,
		devCount: deps.filter(d => d.type === 'development').length,
		prodCount: deps.filter(d => d.type === 'production').length,
		outdatedCount: 0
	}];
}

async function getAllDependencies(workspace?: string): Promise<EcosystemDependencies[]> {
	const workspaceRoot = await getWorkspaceRoot(workspace);
	const allResults: EcosystemDependencies[] = [];
	allResults.push(...await getNodeDependencies(workspaceRoot));
	allResults.push(...await getPythonDependencies(workspaceRoot));
	allResults.push(...await getRustDependencies(workspaceRoot));
	allResults.push(...await getGoDependencies(workspaceRoot));
	allResults.push(...await getPhpDependencies(workspaceRoot));
	allResults.push(...await getRubyDependencies(workspaceRoot));
	return allResults;
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

async function findTodoComments(options: TodoOptions): Promise<{ matches: TodoMatch[] | Record<string, TodoMatch[]>; stats: TodoStats }> {
	const target = resolveRelativeToolPath(options.path ?? '.', options.workspace);
	const workspaceRoot = target.dir;
	const defaultPatterns = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REVIEW', 'WARNING', 'TEMP'];
	const searchPatterns = options.customPatterns ? [...defaultPatterns, ...options.customPatterns] : defaultPatterns;
	const caseSensitive = options.caseSensitive ?? false;
	const contextLines = options.contextLines ?? 2;
	const groupBy = options.groupBy ?? 'file';
	const excludePatterns = options.exclude ?? [
		'**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.js',
		'**/*.map', '**/vendor/**', '**/.next/**', '**/target/**', '**/__pycache__/**'
	];
	const includePatterns = options.include ?? ['**/*'];

	const patternRegex = new RegExp(
		`(${searchPatterns.map(p => caseSensitive ? p : p.toLowerCase()).join('|')})`,
		caseSensitive ? '' : 'i'
	);

	const excludeRegexes = excludePatterns.map(globToRegExp);
	const includeRegexes = includePatterns.map(globToRegExp);
	const includeAll = includePatterns.includes('**/*');

	const matches: TodoMatch[] = [];

	async function searchFiles(dir: string): Promise<void> {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = path.relative(workspaceRoot, fullPath);

			if (excludeRegexes.some(regex => regex.test(relativePath))) {
				continue;
			}
			if (!includeAll && !includeRegexes.some(regex => regex.test(relativePath))) {
				continue;
			}

			if (entry.isDirectory()) {
				await searchFiles(fullPath);
			} else if (entry.isFile()) {
				try {
					const content = fs.readFileSync(fullPath, 'utf-8');
					const lines = content.split('\n');
					for (let i = 0; i < lines.length; i++) {
						const searchLine = caseSensitive ? lines[i] : lines[i].toLowerCase();
						const match = searchLine.match(patternRegex);
						if (!match) {
							continue;
						}
						const tag = match[1].toUpperCase();
						const contextStart = Math.max(0, i - contextLines);
						const contextEnd = Math.min(lines.length - 1, i + contextLines);
						let severity: TodoMatch['severity'] = 'low';
						if (['FIXME', 'BUG', 'HACK', 'XXX'].includes(tag)) {
							severity = 'high';
						} else if (['TODO', 'OPTIMIZE', 'REVIEW'].includes(tag)) {
							severity = 'medium';
						}
						matches.push({
							file: `${target.displayPrefix}${relativePath}`,
							line: i + 1,
							column: lines[i].indexOf(match[0]) + 1,
							tag,
							text: lines[i].trim(),
							context: {
								before: lines.slice(contextStart, i),
								after: lines.slice(i + 1, contextEnd + 1)
							},
							severity
						});
					}
				} catch {

				}
			}
		}
	}

	await searchFiles(workspaceRoot);

	const byTag: Record<string, number> = {};
	const byFile: Record<string, number> = {};
	const bySeverity = { high: 0, medium: 0, low: 0 };
	for (const m of matches) {
		byTag[m.tag] = (byTag[m.tag] || 0) + 1;
		byFile[m.file] = (byFile[m.file] || 0) + 1;
		bySeverity[m.severity]++;
	}

	let grouped: Record<string, TodoMatch[]> = {};
	if (groupBy === 'file') {
		grouped = matches.reduce<Record<string, TodoMatch[]>>((acc, m) => {
			(acc[m.file] = acc[m.file] || []).push(m);
			return acc;
		}, {});
	} else if (groupBy === 'tag') {
		grouped = matches.reduce<Record<string, TodoMatch[]>>((acc, m) => {
			(acc[m.tag] = acc[m.tag] || []).push(m);
			return acc;
		}, {});
	}

	return {
		matches: groupBy === 'none' ? matches : grouped,
		stats: { total: matches.length, byTag, byFile, bySeverity }
	};
}

async function getFileHistory(options: {
	path: string;
	maxCommits?: number;
	since?: string;
	until?: string;
	author?: string;
	grep?: string;
	includeStats?: boolean;
	includeDiff?: boolean;
	format?: string;
	workspace?: string;
}): Promise<string> {

	const target = resolveRelativeToolPath(options.path, options.workspace);
	const workspaceRoot = target.root;
	const filePath = target.gitPath;
	const maxCommits = options.maxCommits ?? 50;
	const includeStats = options.includeStats ?? true;
	const includeDiff = options.includeDiff ?? false;
	const format = options.format ?? 'json';

	let cmd = `git log --follow --pretty=format:"%H|%h|%an|%ae|%ad|%s" --date=iso`;
	if (maxCommits) {
		cmd += ` -n ${maxCommits}`;
	}
	if (options.since) {
		cmd += ` --since="${options.since}"`;
	}
	if (options.until) {
		cmd += ` --until="${options.until}"`;
	}
	if (options.author) {
		cmd += ` --author="${options.author}"`;
	}
	if (options.grep) {
		cmd += ` --grep="${options.grep}"`;
	}
	if (includeStats) {
		cmd += ` --numstat`;
	}
	cmd += ` -- "${filePath}"`;

	const result = await runCommand(cmd, workspaceRoot);
	if (result.exitCode !== 0) {
		return format === 'json' ? JSON.stringify({ error: result.output }) : result.output;
	}

	const lines = result.output.trim().split('\n');
	const commits: FileHistoryCommit[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i].trim();
		if (!line) {
			i++;
			continue;
		}
		const parts = line.split('|');
		if (parts.length >= 6) {
			const commit: FileHistoryCommit = {
				hash: parts[0],
				shortHash: parts[1],
				author: { name: parts[2], email: parts[3] },
				date: parts[4],
				message: parts[5]
			};

			if (includeStats) {
				let insertions = 0;
				let deletions = 0;
				let files = 0;
				i++;
				while (i < lines.length && lines[i].trim() && !lines[i].includes('|')) {
					const statParts = lines[i].trim().split('\t');
					if (statParts.length >= 3 && (statParts[2] === filePath || statParts[2].endsWith('/' + filePath))) {
						insertions += parseInt(statParts[0]) || 0;
						deletions += parseInt(statParts[1]) || 0;
						files++;
					}
					i++;
				}
				commit.stats = { files, insertions, deletions };

				i--;
			}

			if (includeDiff) {
				const diffResult = await runCommand(`git show ${commit.hash} -- "${filePath}"`, workspaceRoot);
				commit.diff = diffResult.output;
			}

			commits.push(commit);
		}
		i++;
	}

	if (format === 'csv') {
		const headers = 'hash,shortHash,author,date,message,files,insertions,deletions';
		const rows = commits.map(c =>
			`${c.hash},${c.shortHash},"${c.author.name} <${c.author.email}>",${c.date},"${c.message}",${c.stats?.files || 0},${c.stats?.insertions || 0},${c.stats?.deletions || 0}`
		);
		return [headers, ...rows].join('\n');
	}

	if (format === 'text') {
		let output = `Git history for ${filePath} (${commits.length} commits):\n\n`;
		for (const c of commits) {
			output += `${c.shortHash} ${c.date} ${c.author.name} <${c.author.email}>\n`;
			output += `  ${c.message}\n`;
			if (c.stats) {
				output += `  Files: ${c.stats.files}, +${c.stats.insertions}/-${c.stats.deletions}\n`;
			}
			output += '\n';
		}
		return output;
	}

	return JSON.stringify({ file: filePath, commits }, null, 2);
}

async function generateDocstring(options: {
	path: string;
	symbol?: string;
	line?: number;
	style?: string;
	includeTypes?: boolean;
	includeExamples?: boolean;
	async?: boolean;
	overwrite?: boolean;
	workspace?: string;
}): Promise<string> {
	const filePath = resolveRelativeToolPath(options.path, options.workspace).fsPath;
	const ext = path.extname(filePath).toLowerCase();

	const content = await readTextFile(filePath);
	if (!content) {
		throw new Error(`File not found: ${options.path}`);
	}

	const lines = content.split('\n');
	let targetLine = options.line ? options.line - 1 : -1;
	const symbolName = options.symbol;

	if (targetLine === -1 && symbolName) {
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(symbolName) && (lines[i].includes('function') || lines[i].includes('def ') || lines[i].includes('fn ') || lines[i].includes('func '))) {
				targetLine = i;
				break;
			}
		}
	}
	if (targetLine === -1) {
		throw new Error('Could not locate function/class to document');
	}

	const targetCode = lines[targetLine].trim();
	const indent = lines[targetLine].match(/^(\s*)/)?.[1] || '';
	let docstring = '';

	if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
		const isTS = ['.ts', '.tsx'].includes(ext);
		let params: Array<{ name: string; type: string }> = [];
		let returnType = 'any';

		const funcMatch = targetCode.match(/(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>))/);
		const name = funcMatch ? (funcMatch[1] || funcMatch[2]) : 'function';
		const paramMatch = targetCode.match(/\(([^)]*)\)/);

		if (paramMatch) {
			const paramStr = paramMatch[1].trim();
			if (paramStr) {
				params = paramStr.split(',').map(p => {
					const pTrim = p.trim();
					const colonIdx = pTrim.indexOf(':');
					if (colonIdx > 0 && isTS) {
						return {
							name: pTrim.substring(0, colonIdx).trim().replace(/[?=].*$/, ''),
							type: pTrim.substring(colonIdx + 1).trim().replace(/=.*$/, '')
						};
					}
					return { name: pTrim.replace(/[?=].*$/, ''), type: 'any' };
				});
			}
			const returnMatch = targetCode.match(/\)\s*:\s*([^{\s]+)/);
			if (returnMatch) {
				returnType = returnMatch[1].trim();
			}

			let doc = `${indent}/**\n${indent} * ${name} - ${name} function\n`;
			for (const p of params) {
				doc += `${indent} * @param {${p.type}} ${p.name} - \n`;
			}
			doc += `${indent} * @returns {${returnType}} - \n`;
			if (options.includeExamples) {
				doc += `${indent} * @example\n${indent} * // Example usage\n`;
			}
			doc += `${indent} */`;
			docstring = doc;
		}
	} else if (ext === '.py') {
		const funcMatch = targetCode.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
		const name = funcMatch ? funcMatch[1] : 'function';
		const params = funcMatch
			? funcMatch[2].split(',').map(p => p.trim().split(':')[0].trim().replace(/=.+$/, '').replace(/\*\*?/, '')).filter(p => p)
			: [];
		const returnMatch = targetCode.match(/\)\s*->\s*([^:]+):/);
		const returnType = returnMatch ? returnMatch[1].trim() : 'Any';

		let doc = `${indent}"""${name}`;
		if (params.length > 0) {
			doc += `\n${indent}\n${indent}Args:`;
			for (const p of params) {
				doc += `\n${indent}    ${p}: `;
			}
		}
		doc += `\n${indent}\n${indent}Returns:\n${indent}    ${returnType}: `;
		if (options.includeExamples) {
			doc += `\n${indent}\n${indent}Example:\n${indent}    # Example usage`;
		}
		doc += `\n${indent}"""`;
		docstring = doc;
	} else if (ext === '.php') {
		const funcMatch = targetCode.match(/function\s+(\w+)\s*\(([^)]*)\)/);
		const name = funcMatch ? funcMatch[1] : 'function';
		const params = funcMatch
			? funcMatch[2].split(',').map(p => {
				const trimmed = p.trim();
				const typeMatch = trimmed.match(/^(\w+)\s+\$(\w+)/);
				return typeMatch ? { name: '$' + typeMatch[2], type: typeMatch[1] } : { name: trimmed.replace(/\$|=.+$/, '').trim(), type: 'mixed' };
			})
			: [];
		const returnMatch = targetCode.match(/\)\s*:\s*(\w+)/);
		const returnType = returnMatch ? returnMatch[1] : 'mixed';

		let doc = `${indent}/**\n${indent} * ${name}\n${indent} *\n`;
		for (const p of params) {
			if (p.name) {
				doc += `${indent} * @param ${p.type} ${p.name} \n`;
			}
		}
		doc += `${indent} * @return ${returnType}\n${indent} */`;
		docstring = doc;
	} else if (ext === '.go') {
		const funcMatch = targetCode.match(/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/);
		const name = funcMatch ? funcMatch[1] : 'function';
		const params = funcMatch
			? funcMatch[2].split(',').map(p => {
				const parts = p.trim().split(/\s+/);
				return parts.length >= 2 ? { name: parts[0], type: parts[parts.length - 1] } : { name: parts[0], type: 'interface{}' };
			})
			: [];
		const returnMatch = targetCode.match(/\)\s+([^{]+)\{/);
		const returnType = returnMatch ? returnMatch[1].trim() : 'interface{}';

		let doc = `${indent}// ${name}`;
		if (params.length > 0) {
			doc += `\n${indent}//\n${indent}// Parameters:`;
			for (const p of params) {
				if (p.name) {
					doc += `\n${indent}//   ${p.name} ${p.type}`;
				}
			}
		}
		doc += `\n${indent}// Returns:\n${indent}//   ${returnType}`;
		docstring = doc;
	} else if (ext === '.rs') {
		const funcMatch = targetCode.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/);
		const name = funcMatch ? funcMatch[1] : 'function';
		const params = funcMatch
			? funcMatch[2].split(',').map(p => {
				const parts = p.trim().split(':');
				return parts.length >= 2 ? { name: parts[0].trim(), type: parts[1].trim() } : { name: p.trim(), type: 'T' };
			}).filter(p => p.name)
			: [];
		const returnMatch = targetCode.match(/\)\s*->\s*([^{]+)\{/);
		const returnType = returnMatch ? returnMatch[1].trim() : '()';

		let doc = `${indent}/// ${name}\n${indent}///`;
		if (params.length > 0) {
			doc += `\n${indent}/// # Arguments`;
			for (const p of params) {
				doc += `\n${indent}/// * \`${p.name}\` - ${p.type}`;
			}
		}
		doc += `\n${indent}///\n${indent}/// # Returns\n${indent}/// * \`${returnType}\``;
		docstring = doc;
	} else {
		throw new Error(`Unsupported file type: ${ext}`);
	}

	if (!docstring) {
		throw new Error('Could not generate docstring for this code');
	}

	if (options.overwrite === false) {
		return docstring;
	}

	if (lines[targetLine - 1]?.trim().startsWith('/**') ||
		lines[targetLine - 1]?.trim().startsWith('"""') ||
		lines[targetLine - 1]?.trim().startsWith("'''") ||
		lines[targetLine - 1]?.trim().startsWith('///') ||
		lines[targetLine - 1]?.trim().startsWith('#')) {
		let startIdx = targetLine - 1;
		while (startIdx > 0) {
			const t = lines[startIdx].trim();

			if (!(t.startsWith('*') || t.startsWith('///') || t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''"))) {
				break;
			}
			startIdx--;
		}
		if (startIdx < targetLine - 1) {
			lines.splice(startIdx + 1, targetLine - startIdx - 1);
			targetLine = startIdx + 1;
		}
	}

	lines.splice(targetLine, 0, docstring);
	fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

	const kind = ext === '.py' ? 'docstring'
		: ext === '.php' ? 'PHPDoc'
			: ext === '.go' ? 'GoDoc'
				: ext === '.rs' ? 'Rustdoc'
					: 'JSDoc';
	return `Generated ${kind} for ${options.path} at line ${targetLine + 1}`;
}

async function getProjectContext(options: {
	depth?: number;
	includeScripts?: boolean;
	includeConfigFiles?: boolean;
	includeReadme?: boolean;
	workspace?: string;
}): Promise<string> {
	const workspaceRoot = await getWorkspaceRoot(options.workspace);
	const depth = options.depth ?? 3;
	const includeScripts = options.includeScripts ?? true;
	const includeConfigFiles = options.includeConfigFiles ?? true;
	const includeReadme = options.includeReadme ?? true;

	const project: any = {
		name: 'Unknown',
		version: 'Unknown',
		description: '',
		rootPath: workspaceRoot,
		languages: [],
		frameworks: [],
		packageManagers: [],
		entryPoints: [],
		scripts: {},
		configFiles: [],
		structure: {},
		keyFiles: [],
		dependencies: { production: 0, development: 0, outdated: 0 },
		testSetup: { framework: '', config: '', testFiles: 0 }
	};

	const pkg = await readJsonFile(path.join(workspaceRoot, 'package.json'));
	if (pkg) {
		project.name = pkg.name || path.basename(workspaceRoot);
		project.version = pkg.version || '0.0.0';
		project.description = pkg.description || '';
		project.packageManagers.push('npm');
		if (includeScripts && pkg.scripts) {
			project.scripts = pkg.scripts;
		}
		const deps: Record<string, string> = pkg.dependencies || {};
		const devDeps: Record<string, string> = pkg.devDependencies || {};
		project.dependencies.production = Object.keys(deps).length;
		project.dependencies.development = Object.keys(devDeps).length;

		const allDeps = { ...deps, ...devDeps };
		if (allDeps.react || allDeps['react-dom']) {
			project.frameworks.push('react');
		}
		if (allDeps.vue) {
			project.frameworks.push('vue');
		}
		if (allDeps.svelte) {
			project.frameworks.push('svelte');
		}
		if (allDeps.next) {
			project.frameworks.push('next.js');
		}
		if (allDeps.nuxt) {
			project.frameworks.push('nuxt');
		}
		if (allDeps.express) {
			project.frameworks.push('express');
		}
		if (allDeps.fastify) {
			project.frameworks.push('fastify');
		}
		if (allDeps.nestjs || allDeps['@nestjs/core']) {
			project.frameworks.push('nestjs');
		}
	}

	const pyproject = await readTextFile(path.join(workspaceRoot, 'pyproject.toml'));
	if (pyproject) {
		project.packageManagers.push('pip/poetry');
		if (pyproject.includes('django')) {
			project.frameworks.push('django');
		}
		if (pyproject.includes('flask')) {
			project.frameworks.push('flask');
		}
		if (pyproject.includes('fastapi')) {
			project.frameworks.push('fastapi');
		}
	}
	if (fs.existsSync(path.join(workspaceRoot, 'requirements.txt'))) {
		project.packageManagers.push('pip');
	}
	if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
		project.packageManagers.push('cargo');
	}
	if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
		project.packageManagers.push('go modules');
	}
	if (fs.existsSync(path.join(workspaceRoot, 'composer.json'))) {
		project.packageManagers.push('composer');
		if (includeScripts) {
			const composer = await readJsonFile(path.join(workspaceRoot, 'composer.json'));
			if (composer?.scripts) {
				project.scripts = { ...project.scripts, ...composer.scripts };
			}
		}
	}

	const langExtensions: Record<string, string> = {
		'.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
		'.py': 'python', '.rs': 'rust', '.go': 'go', '.php': 'php', '.rb': 'ruby',
		'.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.dart': 'dart',
		'.cs': 'csharp', '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
		'.lua': 'lua', '.pl': 'perl', '.r': 'r', '.scala': 'scala',
		'.clj': 'clojure', '.ex': 'elixir', '.exs': 'elixir',
		'.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.fish': 'fish',
		'.ps1': 'powershell', '.sql': 'sql', '.html': 'html', '.css': 'css',
		'.scss': 'scss', '.sass': 'sass', '.less': 'less',
		'.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
		'.xml': 'xml', '.md': 'markdown', '.txt': 'text'
	};
	const ignoredDirs = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', '.next', '.git']);
	const foundLangs = new Set<string>();

	function scanDir(dir: string, currentDepth = 0): void {
		if (currentDepth > depth) {
			return;
		}
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) {
					continue;
				}
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					scanDir(fullPath, currentDepth + 1);
				} else {
					const ext = path.extname(entry.name).toLowerCase();
					if (langExtensions[ext]) {
						foundLangs.add(langExtensions[ext]);
					}
				}
			}
		} catch { }
	}
	scanDir(workspaceRoot);
	project.languages = Array.from(foundLangs).sort();

	if (includeConfigFiles) {
		const configFiles = [
			'tsconfig.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json',
			'jest.config.js', 'vitest.config.ts', 'vite.config.ts', 'webpack.config.js', 'rollup.config.js',
			'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', '.dockerignore', '.gitignore',
			'.env.example', 'README.md', 'CHANGELOG.md', 'LICENSE'
		];
		for (const cf of configFiles) {
			if (fs.existsSync(path.join(workspaceRoot, cf))) {
				project.configFiles.push(cf);
			}
		}
	}

	if (includeReadme) {
		for (const rf of ['README.md', 'README.txt', 'README.rst', 'README']) {
			const rfPath = path.join(workspaceRoot, rf);
			if (fs.existsSync(rfPath)) {
				const content = await readTextFile(rfPath);
				if (content) {
					project.keyFiles.push({ path: rf, summary: content.substring(0, 500) + (content.length > 500 ? '...' : '') });
				}
				break;
			}
		}
	}

	for (const ep of ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'src/App.tsx', 'src/App.jsx', 'main.py', 'app.py', 'main.rs', 'main.go', 'index.php', 'cmd/main.go', 'bin/www']) {
		if (fs.existsSync(path.join(workspaceRoot, ep))) {
			project.entryPoints.push({ type: 'source', file: ep });
		}
	}
	if (pkg?.main) {
		project.entryPoints.push({ type: 'main', file: pkg.main });
	}
	if (pkg?.module) {
		project.entryPoints.push({ type: 'module', file: pkg.module });
	}

	function buildStructure(dir: string, currentDepth = 0): Record<string, any> {
		if (currentDepth > depth) {
			return {};
		}
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const result: Record<string, any> = {};
			for (const entry of entries) {
				if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) {
					continue;
				}
				if (entry.isDirectory()) {
					result[entry.name] = buildStructure(path.join(dir, entry.name), currentDepth + 1);
				} else {
					result[entry.name] = 'file';
				}
			}
			return result;
		} catch {
			return {};
		}
	}
	project.structure = buildStructure(workspaceRoot);

	if (fs.existsSync(path.join(workspaceRoot, 'jest.config.js')) || fs.existsSync(path.join(workspaceRoot, 'jest.config.ts'))) {
		project.testSetup.framework = 'jest';
		project.testSetup.config = 'jest.config.js';
	} else if (fs.existsSync(path.join(workspaceRoot, 'vitest.config.ts')) || fs.existsSync(path.join(workspaceRoot, 'vitest.config.js'))) {
		project.testSetup.framework = 'vitest';
		project.testSetup.config = 'vitest.config.ts';
	} else if (fs.existsSync(path.join(workspaceRoot, 'pytest.ini')) || fs.existsSync(path.join(workspaceRoot, 'pyproject.toml'))) {
		project.testSetup.framework = 'pytest';
	} else if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
		project.testSetup.framework = 'cargo test';
	}

	const testDirs = ['tests', 'test', '__tests__', 'spec', '__spec__'];
	let testCount = 0;
	const countTestFiles = (dir: string): number => {
		let count = 0;
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					count += countTestFiles(path.join(dir, entry.name));
				} else if (entry.name.match(/\.(test|spec)\.(js|ts|jsx|tsx|py|rs|go)$/)) {
					count++;
				}
			}
		} catch { }
		return count;
	};
	for (const td of testDirs) {
		const tdPath = path.join(workspaceRoot, td);
		if (fs.existsSync(tdPath)) {
			testCount += countTestFiles(tdPath);
		}
	}
	project.testSetup.testFiles = testCount;

	return JSON.stringify({ project }, null, 2);
}

export function registerDocumentationTools(server: McpServer): void {
	server.tool('get_package_dependencies_code', `Lists all project dependencies across all package managers (npm, pip, cargo, go, composer, bundler, etc.).

WHEN TO USE: Auditing dependencies, checking versions, finding outdated packages, security reviews.

Supports: npm/yarn/pnpm, pip/poetry/pipenv, cargo, go modules, composer, bundler, and more.
Returns unified format with type (prod/dev/peer/optional), ecosystem, and metadata.`, {
		ecosystem: z.enum(['all', 'npm', 'pypi', 'cargo', 'go', 'composer', 'bundler', 'nuget', 'maven', 'gradle']).optional().default('all').describe('Filter by ecosystem (default: all)'),
		includeOutdated: z.boolean().optional().default(false).describe('Check for outdated versions (slower)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ ecosystem = 'all', includeOutdated = false, workspace }) => {
		try {

			const ecosystemAliases: Record<string, string[]> = {
				npm: ['node'],
				pypi: ['python'],
				cargo: ['rust'],
				go: ['go'],
				composer: ['php'],
				bundler: ['ruby']
			};
			const results = await getAllDependencies(workspace);
			const wanted = ecosystemAliases[ecosystem] || [ecosystem];
			const filtered = ecosystem === 'all' ? results : results.filter(r => wanted.includes(r.ecosystem));

			let output = `# Project Dependencies\n\n`;
			output += `Total ecosystems: ${filtered.length}\n\n`;
			for (const r of filtered) {
				output += `## ${r.ecosystem.toUpperCase()} (${r.manager})\n`;
				output += `- Manifest: ${r.manifestPath}\n`;
				if (r.lockfilePath) {
					output += `- Lockfile: ${r.lockfilePath}\n`;
				}
				output += `- Total: ${r.totalCount} (prod: ${r.prodCount}, dev: ${r.devCount})\n`;
				if (r.dependencies.length > 0) {
					output += `\n| Package | Version | Type |\n|---------|---------|------|\n`;
					for (const dep of r.dependencies.slice(0, 50)) {
						output += `| ${dep.name} | ${dep.version} | ${dep.type} |\n`;
					}
					if (r.dependencies.length > 50) {
						output += `\n... and ${r.dependencies.length - 50} more\n`;
					}
				}
				output += '\n';
			}
			if (includeOutdated) {
				output += '\n> ⚠️ Outdated check not implemented in this version. Run `npm outdated`, `pip list --outdated`, `cargo outdated`, etc. manually.\n';
			}
			return { content: [{ type: 'text', text: output }] };
		} catch (error) {
			console.error('[get_package_dependencies_code] Error:', error);
			throw error;
		}
	});

	server.tool('get_file_history_code', `Shows git commit history for a specific file with stats and optional diffs.

WHEN TO USE: Understanding how a file evolved, finding when bugs were introduced, code archaeology.

Supports filtering by date, author, commit message, and commit count. Returns structured data with stats.`, {
		path: z.string().describe('File path relative to workspace root'),
		maxCommits: z.number().optional().default(50).describe('Maximum commits to return'),
		since: z.string().optional().describe('ISO date or relative (e.g., "2 weeks ago")'),
		until: z.string().optional().describe('ISO date or relative'),
		author: z.string().optional().describe('Filter by author name/email'),
		grep: z.string().optional().describe('Filter commit messages'),
		includeStats: z.boolean().optional().default(true).describe('Include file change stats'),
		includeDiff: z.boolean().optional().default(false).describe('Include full diff per commit'),
		format: z.enum(['json', 'text', 'csv']).optional().default('json').describe('Output format'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: filePath, maxCommits = 50, since, until, author, grep, includeStats = true, includeDiff = false, format = 'json', workspace }) => {
		try {
			const result = await getFileHistory({ path: filePath, maxCommits, since, until, author, grep, includeStats, includeDiff, format, workspace });
			return { content: [{ type: 'text', text: result }] };
		} catch (error) {
			console.error('[get_file_history_code] Error:', error);
			throw error;
		}
	});

	server.tool('generate_docstring_code', `Generates docstrings for functions/classes in multiple languages (JS/TS, Python, PHP, Go, Rust, etc.).

WHEN TO USE: Adding documentation to undocumented functions, standardizing docstring style.

Auto-detects language from file extension. Supports JSDoc, Google/NumPy Python, PHPDoc, GoDoc, Rustdoc, etc.
Can insert directly into file or return the docstring only.`, {
		path: z.string().describe('File path relative to workspace root'),
		symbol: z.string().optional().describe('Function/class name to document (auto-detects from line if omitted)'),
		line: z.number().optional().describe('Line number (1-based) of the function/class'),
		style: z.string().optional().describe('Docstring style override (e.g., "google", "numpy", "jsdoc", "godoc")'),
		includeTypes: z.boolean().optional().default(true).describe('Include parameter/return types'),
		includeExamples: z.boolean().optional().default(false).describe('Include example section'),
		async: z.boolean().optional().describe('Mark function as async'),
		overwrite: z.boolean().optional().default(true).describe('Overwrite existing docstring'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: filePath, symbol, line, includeExamples = false, overwrite = true, workspace }) => {
		try {
			const result = await generateDocstring({ path: filePath, symbol, line, includeExamples, overwrite, workspace });
			return { content: [{ type: 'text', text: result }] };
		} catch (error) {
			console.error('[generate_docstring_code] Error:', error);
			throw error;
		}
	});

	server.tool('get_project_context_code', `Provides a comprehensive project summary: stack, structure, dependencies, entry points, scripts, and test setup.

WHEN TO USE: Onboarding to a new codebase, getting project overview before making changes, context for AI.

Aggregates package.json, configs, file structure, languages, frameworks, entry points, and test setup.`, {
		depth: z.number().optional().default(3).describe('Directory depth for structure tree'),
		includeDeps: z.boolean().optional().default(true).describe('Include dependency summary'),
		includeScripts: z.boolean().optional().default(true).describe('Include npm/composer scripts'),
		includeConfigFiles: z.boolean().optional().default(true).describe('List config files found'),
		includeReadme: z.boolean().optional().default(true).describe('Include README summary'),
		maxFileSize: z.number().optional().default(102400).describe('Max file size for content reads (bytes)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ depth = 3, includeScripts = true, includeConfigFiles = true, includeReadme = true, workspace }) => {
		try {
			const result = await getProjectContext({ depth, includeScripts, includeConfigFiles, includeReadme, workspace });
			return { content: [{ type: 'text', text: result }] };
		} catch (error) {
			console.error('[get_project_context_code] Error:', error);
			throw error;
		}
	});

	server.tool('find_todo_code', `Searches for TODO/FIXME/HACK/XXX/NOTE/BUG/OPTIMIZE/REVIEW comments across the workspace.

WHEN TO USE: Technical debt tracking, sprint planning, code quality reviews.

Supports custom patterns, filtering by path/file type, grouping by file or tag, and context lines.
Returns structured data with severity classification (high/medium/low).`, {
		customPatterns: z.array(z.string()).optional().describe('Additional tag patterns on top of the defaults'),
		path: z.string().optional().describe('Search path (default: workspace root)'),
		include: z.array(z.string()).optional().describe('Glob patterns to include'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude (default: node_modules, .git, dist, build, etc.)'),
		caseSensitive: z.boolean().optional().default(false).describe('Case sensitive search'),
		contextLines: z.number().optional().default(2).describe('Lines of context around matches'),
		format: z.enum(['json', 'text', 'markdown']).optional().default('json').describe('Output format'),
		groupBy: z.enum(['file', 'tag', 'none']).optional().default('file').describe('Group results by file, tag, or flat list'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ customPatterns, path: searchPath, include, exclude, caseSensitive = false, contextLines = 2, format = 'json', groupBy = 'file', workspace }) => {
		try {
			const result = await findTodoComments({ customPatterns, path: searchPath, include, exclude, caseSensitive, contextLines, groupBy, workspace });

			if (format === 'markdown') {
				let output = `# TODO/FIXME Report\n\n`;
				output += `Total: ${result.stats.total} | High: ${result.stats.bySeverity.high} | Medium: ${result.stats.bySeverity.medium} | Low: ${result.stats.bySeverity.low}\n\n`;
				output += '## By Tag\n';
				for (const [tag, count] of Object.entries(result.stats.byTag)) {
					output += `- ${tag}: ${count}\n`;
				}
				output += '\n';

				const groups = Array.isArray(result.matches)
					? [['All matches', result.matches] as [string, TodoMatch[]]]
					: Object.entries(result.matches);
				for (const [group, items] of groups) {
					output += `## ${group} (${items.length})\n`;
					for (const item of items.slice(0, 20)) {
						output += `- \`${item.file}:${item.line}\` [${item.tag}] ${item.text}\n`;
					}
					if (items.length > 20) {
						output += `... and ${items.length - 20} more\n`;
					}
					output += '\n';
				}
				return { content: [{ type: 'text', text: output }] };
			}

			if (format === 'text') {
				const flat = Array.isArray(result.matches) ? result.matches : Object.values(result.matches).flat();
				let output = `Found ${result.stats.total} matches:\n\n`;
				for (const m of flat) {
					output += `${m.file}:${m.line} [${m.tag}] ${m.text}\n`;
				}
				return { content: [{ type: 'text', text: output }] };
			}

			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		} catch (error) {
			console.error('[find_todo_code] Error:', error);
			throw error;
		}
	});
}
