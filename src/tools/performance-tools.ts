import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveWorkspaceFolder, resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { executeShellCommand } from './shell-tools';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode-mcp', '__pycache__']);

async function getWorkspaceRoot(ref?: string): Promise<string> {
	return resolveWorkspaceFolder(ref).uri.fsPath;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${bytes} B`;
}

interface FileSize { path: string; size: number }

function collectSizes(rootDir: string, subDir: string): { files: FileSize[]; totalBytes: number } {
	const files: FileSize[] = [];
	const base = path.join(rootDir, subDir);
	function walk(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				try {
					files.push({ path: path.relative(base, fullPath).replace(/\\/g, '/'), size: fs.statSync(fullPath).size });
				} catch {

				}
			}
		}
	}
	if (fs.existsSync(base)) {
		walk(base);
	}
	return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) };
}

async function analyzeBundle(bundleDir: string, topCount: number, workspace?: string): Promise<string> {
	const target = resolveRelativeToolPath(bundleDir, workspace);
	const resolved = target.fsPath;
	if (!fs.existsSync(resolved)) {
		return `Directory not found: ${bundleDir} — build the project first or pass another directory.`;
	}
	const { files, totalBytes } = collectSizes(target.dir, '');
	if (files.length === 0) {
		return `${bundleDir} exists but contains no files.`;
	}
	const sorted = [...files].sort((a, b) => b.size - a.size);
	let output = `Bundle analysis of ${bundleDir}: ${files.length} file(s), ${formatBytes(totalBytes)} total.\n\n| File | Size | Share |\n|---|---|---|\n`;
	for (const file of sorted.slice(0, topCount)) {
		const share = totalBytes > 0 ? `${((file.size / totalBytes) * 100).toFixed(1)}%` : '-';
		output += `| ${target.displayPrefix}${file.path} | ${formatBytes(file.size)} | ${share} |\n`;
	}
	if (sorted.length > topCount) {
		output += `\n... and ${sorted.length - topCount} more files accounting for ${formatBytes(sorted.slice(topCount).reduce((sum, f) => sum + f.size, 0))}.`;
	}
	return output;
}

function directorySize(dir: string): number {
	let total = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += directorySize(fullPath);
		} else if (entry.isFile()) {
			try {
				total += fs.statSync(fullPath).size;
			} catch {

			}
		}
	}
	return total;
}

async function performanceReport(workspace?: string): Promise<string> {
	const workspaceRoot = await getWorkspaceRoot(workspace);
	const mem = process.memoryUsage();

	let fileCount = 0;
	let totalBytes = 0;
	const queue = [workspaceRoot];
	while (queue.length > 0 && fileCount < 200000) {
		const dir = queue.shift() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					queue.push(fullPath);
				}
			} else if (entry.isFile()) {
				fileCount += 1;
				try {
					totalBytes += fs.statSync(fullPath).size;
				} catch {

				}
			}
		}
	}

	let output = '# Performance Report\n\n';
	output += `- Server uptime: ${process.uptime().toFixed(1)} s\n`;
	output += `- Memory: RSS ${formatBytes(mem.rss)}, heap used ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}\n`;
	output += `- Node version: ${process.version}\n`;
	output += `- Workspace files scanned: ${fileCount}, ${formatBytes(totalBytes)}\n`;

	const nodeModules = path.join(workspaceRoot, 'node_modules');
	if (fs.existsSync(nodeModules)) {
		const packages: Array<{ name: string; size: number }> = [];
		for (const name of fs.readdirSync(nodeModules)) {
			if (name.startsWith('@')) {

				const scopeDir = path.join(nodeModules, name);
				for (const inner of fs.readdirSync(scopeDir)) {
					packages.push({ name: `${name}/${inner}`, size: directorySize(path.join(scopeDir, inner)) });
				}
			} else {
				packages.push({ name, size: directorySize(path.join(nodeModules, name)) });
			}
		}
		packages.sort((a, b) => b.size - a.size);
		output += `\nHeaviest installed packages:\n`;
		for (const pkg of packages.slice(0, 10)) {
			output += `- ${pkg.name}: ${formatBytes(pkg.size)}\n`;
		}
	}

	return output;
}

let sharedTerminal: vscode.Terminal | undefined;

async function profileCommand(command: string, runs: number, workspace?: string): Promise<string> {
	if (!sharedTerminal) {
		throw new Error('Terminal not available for performance tools');
	}
	const workspaceRoot = await getWorkspaceRoot(workspace);
	const durations: number[] = [];
	let lastOutput = '';
	let lastExit = 0;
	for (let i = 0; i < runs; i++) {
		const startedAt = Date.now();
		try {
			const result = await executeShellCommand(sharedTerminal, command, workspaceRoot, 120000);
			durations.push(Date.now() - startedAt);
			lastOutput = result.output;
			lastExit = result.exitCode;
		} catch (error) {
			durations.push(Date.now() - startedAt);
			lastOutput = error instanceof Error ? error.message : String(error);
			lastExit = 1;
		}
	}
	const best = Math.min(...durations);
	const worst = Math.max(...durations);
	const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
	let output = `Profiled "${command}" (${runs} run(s)):\n`;
	output += `- Mean: ${(mean / 1000).toFixed(2)} s, best: ${(best / 1000).toFixed(2)} s, worst: ${(worst / 1000).toFixed(2)} s\n`;
	output += `- Exit code: ${lastExit}\n\n--- Last run output ---\n${lastOutput.slice(0, 3000)}`;
	return output;
}

export function registerPerformanceTools(server: McpServer, terminal?: vscode.Terminal): void {
	sharedTerminal = terminal;

	server.tool('analyze_bundle_code', `Analyzes the size of a build output directory: total bytes, per-file sizes and the largest files with their share of the bundle.

WHEN TO USE: after a build, spotting bloated assets before shipping, comparing bundler configuration changes.`, {
		dir: z.string().optional().default('dist').describe('Directory to analyze, relative to the workspace root'),
		top: z.number().int().min(1).max(50).optional().default(15).describe('How many of the largest files to list'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ dir = 'dist', top = 15, workspace }) => {
		const result = await analyzeBundle(dir, top, workspace);
		return { content: [{ type: 'text', text: result }] };
	});

	server.tool('get_performance_report_code', `Reports the MCP server's own footprint (uptime, RSS/heap memory, Node version) plus workspace weight: file count, total size and the heaviest installed npm packages.

WHEN TO USE: checking what an agent session is costing in memory, finding dependency bloat.`, {
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ workspace }) => {
		const result = await performanceReport(workspace);
		return { content: [{ type: 'text', text: result }] };
	});

	server.tool('profile_command_code', `Runs a shell command one or more times through the extension terminal and reports wall-clock timing statistics alongside the command's output.

WHEN TO USE: measuring how long a build/test/bundle step really takes, comparing toolchain changes with repeatable numbers.`, {
		command: z.string().describe('Shell command to measure'),
		runs: z.number().int().min(1).max(10).optional().default(1).describe('Number of runs (best/worst/mean are reported)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ command, runs = 1, workspace }) => {
		const result = await profileCommand(command, runs, workspace);
		return { content: [{ type: 'text', text: result }] };
	});
}
