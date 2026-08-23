import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { executeShellCommand } from './shell-tools.js';

function getWorkspaceRoot(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('No workspace folder is open');
	}
	return folder.uri.fsPath;
}

function readJsonFile(filePath: string): any {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

// Snippet files are JSONC in practice, so tolerate whole-line comments before parsing
function readJsoncFile(filePath: string): any {
	const raw = fs.readFileSync(filePath, 'utf-8');
	try {
		return JSON.parse(raw);
	} catch {
		const stripped = raw
			.split('\n')
			.filter(line => !line.trim().startsWith('//'))
			.join('\n')
			.replace(/\/\*[\s\S]*?\*\//g, '');
		return JSON.parse(stripped);
	}
}

interface TaskInfo {
	source: 'npm' | 'composer' | 'make';
	name: string;
	command: string;
	definition: string;
}

function discoverTasks(root: string): TaskInfo[] {
	const tasks: TaskInfo[] = [];

	const pkg = readJsonFile(path.join(root, 'package.json'));
	for (const [name, definition] of Object.entries(pkg?.scripts ?? {})) {
		tasks.push({ source: 'npm', name, command: `npm run ${name}`, definition: String(definition) });
	}

	const composer = readJsonFile(path.join(root, 'composer.json'));
	for (const [name, definition] of Object.entries(composer?.scripts ?? {})) {
		tasks.push({ source: 'composer', name, command: `composer run-script ${name}`, definition: String(definition) });
	}

	const makefilePath = path.join(root, 'Makefile');
	if (fs.existsSync(makefilePath)) {
		const seen = new Set<string>();
		for (const line of fs.readFileSync(makefilePath, 'utf-8').split('\n')) {
			const match = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*):(?![^=]*=)/);
			if (match && !seen.has(match[1])) {
				seen.add(match[1]);
				tasks.push({ source: 'make', name: match[1], command: `make ${match[1]}`, definition: 'Makefile target' });
			}
		}
	}

	return tasks;
}

function detectBuildCommand(root: string): { command: string; origin: string } | null {
	const pkg = readJsonFile(path.join(root, 'package.json'));
	if (pkg?.scripts?.build) {
		return { command: 'npm run build', origin: 'package.json build script' };
	}
	if (pkg?.scripts?.compile) {
		return { command: 'npm run compile', origin: 'package.json compile script' };
	}
	if (fs.existsSync(path.join(root, 'Makefile'))) {
		return { command: 'make', origin: 'Makefile default target' };
	}
	if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
		return { command: 'npx tsc', origin: 'tsconfig.json found' };
	}
	return null;
}

interface AliasInfo {
	command: string;
	description?: string;
}

function loadAliases(root: string): Map<string, AliasInfo> {
	const aliases = new Map<string, AliasInfo>();
	const raw = readJsonFile(path.join(root, '.mcp-aliases.json'));
	if (!raw || typeof raw !== 'object') {
		return aliases;
	}
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === 'string') {
			aliases.set(name, { command: value });
		} else if (value && typeof value === 'object' && typeof (value as any).command === 'string') {
			aliases.set(name, { command: (value as any).command, description: (value as any).description });
		}
	}
	return aliases;
}

interface SnippetInfo {
	file: string;
	name: string;
	prefix: string;
	description: string;
	scope: string;
	bodyLines: number;
	bodyPreview: string;
}

function loadSnippets(root: string, prefixFilter: string): SnippetInfo[] {
	const snippetsDir = path.join(root, '.vscode', 'snippets');
	if (!fs.existsSync(snippetsDir)) {
		return [];
	}

	const snippets: SnippetInfo[] = [];
	for (const fileName of fs.readdirSync(snippetsDir)) {
		if (!fileName.endsWith('.json') && !fileName.endsWith('.code-snippets')) {
			continue;
		}
		const filePath = path.join(snippetsDir, fileName);
		let parsed: any;
		try {
			parsed = readJsoncFile(filePath);
		} catch {
			snippets.push({
				file: fileName,
				name: '(unparsable)',
				prefix: '',
				description: 'the file exists but could not be parsed as JSON/JSONC',
				scope: '',
				bodyLines: 0,
				bodyPreview: ''
			});
			continue;
		}
		for (const [name, snippet] of Object.entries(parsed ?? {})) {
			if (!snippet || typeof snippet !== 'object') {
				continue;
			}
			const s = snippet as any;
			const prefix = Array.isArray(s.prefix) ? s.prefix.join(', ') : String(s.prefix ?? '');
			if (prefixFilter && !prefix.toLowerCase().includes(prefixFilter.toLowerCase())) {
				continue;
			}
			const body = Array.isArray(s.body) ? s.body.map(String) : typeof s.body === 'string' ? [String(s.body)] : [];
			const preview = body.slice(0, 8).join('\n') + (body.length > 8 ? '\n...' : '');
			snippets.push({
				file: fileName,
				name,
				prefix,
				description: String(s.description ?? ''),
				scope: String(s.scope ?? ''),
				bodyLines: body.length,
				bodyPreview: preview
			});
		}
	}
	return snippets;
}

async function runInTerminal(
	terminal: vscode.Terminal | undefined,
	command: string,
	cwd: string,
	timeout: number
): Promise<{ output: string; exitCode: number }> {
	if (!terminal) {
		throw new Error('Terminal not available');
	}
	const effectiveCwd = !cwd || cwd === '.' || cwd === './' ? undefined : cwd;
	return executeShellCommand(terminal, command, effectiveCwd ?? getWorkspaceRoot(), timeout);
}

/**
 * Registers MCP workflow tools with the server
 * @param server MCP server instance
 * @param terminal The terminal used to execute tasks, builds and aliases
 */
export function registerWorkflowTools(server: McpServer, terminal?: vscode.Terminal): void {
	server.tool(
		'run_task_code',
		`Runs project tasks discovered from package.json scripts, composer.json scripts or Makefile targets.

        WHEN TO USE: Executing the project's own scripts without remembering the underlying command.

        Call without a task to list everything available, then pass the task name. Extra CLI arguments go in args.`,
		{
			task: z.string().optional().default('').describe('Task name to run. Omit or leave empty to list available tasks'),
			args: z.string().optional().default('').describe('Extra command-line arguments appended to the task command'),
			cwd: z.string().optional().default('.').describe('Working directory (defaults to workspace root)'),
			timeout: z.number().optional().default(120000).describe('Timeout in milliseconds (default: 120000)')
		},
		async ({ task = '', args = '', cwd = '.', timeout = 120000 }): Promise<CallToolResult> => {
			const root = getWorkspaceRoot();
			const tasks = discoverTasks(root);

			if (!task.trim()) {
				if (tasks.length === 0) {
					return { content: [{ type: 'text', text: 'No tasks found. Add scripts to package.json, composer.json, or targets to a Makefile.' }] };
				}
				const lines: string[] = [`Available tasks (${tasks.length}):`];
				let currentSource = '';
				for (const t of tasks) {
					if (t.source !== currentSource) {
						currentSource = t.source;
						lines.push('');
						lines.push(`${t.source === 'npm' ? 'npm (package.json)' : t.source === 'composer' ? 'composer (composer.json)' : 'Makefile'}:`);
					}
					lines.push(`  ${t.name} — ${t.definition}`);
				}
				lines.push('', 'Run one with run_task_code { task: "<name>" }.');
				return { content: [{ type: 'text', text: lines.join('\n') }] };
			}

			if (!/^[A-Za-z0-9_./:@-]+$/.test(task)) {
				throw new Error(`Invalid task name "${task}"`);
			}
			const match = tasks.filter(t => t.name === task);
			if (match.length === 0) {
				throw new Error(`Task "${task}" not found. Available: ${tasks.map(t => t.name).join(', ') || 'none'}`);
			}
			const chosen = match[0];
			const fullCommand = args.trim() ? `${chosen.command} ${args.trim()}` : chosen.command;
			const { output, exitCode } = await runInTerminal(terminal, fullCommand, cwd, timeout);
			return {
				content: [{
					type: 'text',
					text: `Task: ${chosen.name} (${chosen.source})\nCommand: ${fullCommand}\nExit code: ${exitCode}\n\nOutput:\n${output}`
				}]
			};
		}
	);

	server.tool(
		'build_project_code',
		`Detects and runs the project's build command.

        WHEN TO USE: Building/compiling before shipping or verifying changes compile.

        Detection order: package.json "build" script, "compile" script, Makefile, tsconfig.json. Pass an explicit command to override detection.`,
		{
			command: z.string().optional().default('').describe('Explicit build command. Omit to auto-detect'),
			cwd: z.string().optional().default('.').describe('Working directory (defaults to workspace root)'),
			timeout: z.number().optional().default(300000).describe('Timeout in milliseconds (default: 300000)')
		},
		async ({ command = '', cwd = '.', timeout = 300000 }): Promise<CallToolResult> => {
			const root = getWorkspaceRoot();
			const build = command.trim()
				? { command: command.trim(), origin: 'explicit command' }
				: detectBuildCommand(root);

			if (!build) {
				return {
					content: [{
						type: 'text',
						text: 'Could not detect a build command (no package.json build/compile script, no Makefile, no tsconfig.json). Pass an explicit command.'
					}]
				};
			}

			const startedAt = Date.now();
			const { output, exitCode } = await runInTerminal(terminal, build.command, cwd, timeout);
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			return {
				content: [{
					type: 'text',
					text: `Build command: ${build.command}\nSource: ${build.origin}\nDuration: ${seconds}s\nExit code: ${exitCode}\n\nOutput:\n${output}`
				}]
			};
		}
	);

	server.tool(
		'list_snippets_code',
		`Lists the VS Code snippets defined in the workspace (.vscode/snippets).

        WHEN TO USE: Discovering existing snippet prefixes before creating new ones, or reviewing what shortcuts the team shares.`,
		{
			prefixFilter: z.string().optional().default('').describe('Only show snippets whose prefix contains this text (case-insensitive)')
		},
		async ({ prefixFilter = '' }): Promise<CallToolResult> => {
			const root = getWorkspaceRoot();
			const snippets = loadSnippets(root, prefixFilter.trim());

			if (snippets.length === 0) {
				return {
					content: [{ type: 'text', text: `No snippets found${prefixFilter ? ` with prefix containing "${prefixFilter}"` : ''}. Snippet files live in .vscode/snippets/*.json or *.code-snippets.` }]
				};
			}

			const blocks = snippets.map(s => {
				if (s.name === '(unparsable)') {
					return `- ${s.file}: ${s.description}`;
				}
				const header = `- ${s.prefix || '(no prefix)'} — ${s.name}${s.description ? `: ${s.description}` : ''}${s.scope ? ` [scope: ${s.scope}]` : ''}`;
				return `${header}\n  file: ${s.file}, body: ${s.bodyLines} line(s)\n${s.bodyPreview.split('\n').map(l => `  | ${l}`).join('\n')}`;
			});
			return { content: [{ type: 'text', text: `Snippets (${snippets.length}):\n\n${blocks.join('\n\n')}` }] };
		}
	);

	server.tool(
		'run_alias_code',
		`Runs a shell alias defined by the team in .mcp-aliases.json at the workspace root.

        WHEN TO USE: Executing shared shortcuts (dev, lint, deploy...) without typing the full command.

        File format: { "dev": { "command": "npm run dev --host", "description": "Start dev server" }, "lint": "eslint ." }. Values can be a plain command string or an object with command and description. Call without a name to list aliases.`,
		{
			name: z.string().optional().default('').describe('Alias name to run. Omit or leave empty to list available aliases'),
			args: z.string().optional().default('').describe('Extra arguments appended to the alias command'),
			cwd: z.string().optional().default('.').describe('Working directory (defaults to workspace root)'),
			timeout: z.number().optional().default(120000).describe('Timeout in milliseconds (default: 120000)')
		},
		async ({ name = '', args = '', cwd = '.', timeout = 120000 }): Promise<CallToolResult> => {
			const root = getWorkspaceRoot();
			const aliases = loadAliases(root);

			if (!name.trim()) {
				if (aliases.size === 0) {
					return {
						content: [{ type: 'text', text: 'No aliases found. Create .mcp-aliases.json at the workspace root, e.g. { "dev": { "command": "npm run dev", "description": "Start dev server" } }.' }]
					};
				}
				const lines = [`Available aliases (${aliases.size}) from .mcp-aliases.json:`];
				for (const [aliasName, info] of aliases) {
					lines.push(`  ${aliasName} — ${info.command}${info.description ? ` (${info.description})` : ''}`);
				}
				return { content: [{ type: 'text', text: lines.join('\n') }] };
			}

			const alias = aliases.get(name.trim());
			if (!alias) {
				throw new Error(`Alias "${name}" not found. Available: ${[...aliases.keys()].join(', ') || 'none'}`);
			}
			const fullCommand = args.trim() ? `${alias.command} ${args.trim()}` : alias.command;
			const { output, exitCode } = await runInTerminal(terminal, fullCommand, cwd, timeout);
			return {
				content: [{
					type: 'text',
					text: `Alias: ${name}${alias.description ? ` (${alias.description})` : ''}\nCommand: ${fullCommand}\nExit code: ${exitCode}\n\nOutput:\n${output}`
				}]
			};
		}
	);
}
