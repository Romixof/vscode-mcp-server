import * as vscode from 'vscode';
import { z } from 'zod';
import { resolveWorkspaceFolder, resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeShellCommand } from './shell-tools';

function getWorkspaceRoot(ref?: string): string {
	return resolveWorkspaceFolder(ref).uri.fsPath;
}

function getTerminal(): vscode.Terminal {
	const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Git');
	return terminal;
}

async function runGitCommand(command: string, cwd?: string): Promise<{ output: string; exitCode: number }> {
	const terminal = getTerminal();
	const workspaceRoot = cwd || getWorkspaceRoot();
	try {

		return await executeShellCommand(terminal, command, workspaceRoot, 30000);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return { output: errorMessage, exitCode: 1 };
	}
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function generateCommitMessage(diffOutput: string): string {
	const lines = diffOutput.split('\n').filter(l => l.trim());
	const fileChanges = lines
		.filter(l => l.startsWith('diff --git') || l.match(/^[AMD]\t/))
		.slice(0, 10);
	if (fileChanges.length === 0) {
		return 'chore: update files';
	}
	const added = fileChanges.filter(l => l.includes('new file') || l.match(/^A\t/)).length;
	const deleted = fileChanges.filter(l => l.includes('deleted file') || l.match(/^D\t/)).length;
	const modified = fileChanges.length - added - deleted;
	const parts: string[] = [];
	if (added > 0) {
		parts.push(`${added} file${added > 1 ? 's' : ''} added`);
	}
	if (modified > 0) {
		parts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
	}
	if (deleted > 0) {
		parts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);
	}
	const summary = parts.join(', ');
	const allFiles = fileChanges.join(' ');
	if (allFiles.includes('test') || allFiles.includes('spec')) {
		return `test: ${summary}`;
	}
	if (allFiles.includes('doc') || allFiles.includes('README') || allFiles.includes('.md')) {
		return `docs: ${summary}`;
	}
	if (allFiles.includes('config') || allFiles.includes('.json') || allFiles.includes('.yaml') || allFiles.includes('.yml')) {
		return `chore: ${summary}`;
	}
	if (added > modified) {
		return `feat: ${summary}`;
	}
	return `fix: ${summary}`;
}

function slugifyBranchName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.substring(0, 50);
}

function assertValidBranchName(name: string): string {
	const slugified = slugifyBranchName(name);
	if (!slugified) {
		throw new Error(`Branch name "${name}" produces an empty slug — use letters and digits`);
	}
	return slugified;
}

export function registerGitTools(server: McpServer): void {
	server.tool('commit_changes_code', `Commits changes with auto-generated conventional commit message based on diff.

WHEN TO USE: Quick commits without writing messages manually. Uses diff summary to generate conventional commit (feat:/fix:/docs:/chore:/test:).

Auto-stages all changes by default. Use amend=true to modify last commit.`, {
		message: z.string().optional().describe('Custom commit message (optional, auto-generated from diff if omitted)'),
		addAll: z.boolean().optional().default(true).describe('Stage all changes before commit (git add -A)'),
		amend: z.boolean().optional().default(false).describe('Amend the previous commit instead of creating new one'),
		noVerify: z.boolean().optional().default(false).describe('Skip pre-commit hooks (--no-verify)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ message, addAll = true, amend = false, noVerify = false, workspace }) => {
		try {
			const cwd = getWorkspaceRoot(workspace);
			const repoCheck = await runGitCommand('git rev-parse --git-dir', cwd);
			if (repoCheck.exitCode !== 0) {
				throw new Error('Not a git repository');
			}
			const status = await runGitCommand('git status --porcelain', cwd);
			if (!status.output.trim() && !amend) {
				return { content: [{ type: 'text', text: 'No changes to commit. Working tree clean.' }] };
			}
			if (addAll && !amend) {
				await runGitCommand('git add -A', cwd);
			}
			let commitMessage = message;
			if (!commitMessage && !amend) {
				const diff = await runGitCommand('git diff --cached --name-status', cwd);
				commitMessage = generateCommitMessage(diff.output);
			}
			if (!commitMessage) {
				commitMessage = 'chore: update';
			}
			let commitCmd = 'git commit';
			if (amend) {
				commitCmd += ' --amend --no-edit';
			} else {
				commitCmd += ` -m ${shellSingleQuote(commitMessage)}`;
			}
			if (noVerify) {
				commitCmd += ' --no-verify';
			}
			const result = await runGitCommand(commitCmd, cwd);
			return {
				content: [{
					type: 'text',
					text: `Commit ${amend ? 'amended' : 'created'}\nMessage: ${commitMessage}\n\n${result.output}`
				}]
			};
		} catch (error) {
			console.error('[commit_changes_code] Error:', error);
			throw error;
		}
	});

	server.tool('create_branch_code', `Creates, switches, or lists Git branches.

WHEN TO USE: Starting new features, hotfixes, or reviewing branch structure.

Creates branch from current HEAD by default. Use 'from' to specify source. Set checkout=false to create without switching.`, {
		name: z.string().describe('Branch name (will be slugified)'),
		from: z.string().optional().describe('Source branch/commit/tag (default: current HEAD)'),
		checkout: z.boolean().optional().default(true).describe('Switch to the new branch after creation'),
		listOnly: z.boolean().optional().default(false).describe('Only list existing branches (local and remote)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ name, from, checkout = true, listOnly = false, workspace }) => {
		try {
			const cwd = getWorkspaceRoot(workspace);
			if (listOnly) {
				const local = await runGitCommand('git branch', cwd);
				const remote = await runGitCommand('git branch -r', cwd);
				return {
					content: [{
						type: 'text',
						text: `Local branches:\n${local.output}\n\nRemote branches:\n${remote.output}`
					}]
				};
			}
			const slugifiedName = assertValidBranchName(name);
			if (slugifiedName !== name) {
				console.log(`[create_branch_code] Slugified branch name: ${name} -> ${slugifiedName}`);
			}
			const exists = await runGitCommand(`git rev-parse --verify "${slugifiedName}"`, cwd);
			if (exists.exitCode === 0) {
				if (checkout) {
					const switchResult = await runGitCommand(`git checkout "${slugifiedName}"`, cwd);
					return {
						content: [{
							type: 'text',
							text: `Branch "${slugifiedName}" already exists. Switched to it.\n${switchResult.output}`
						}]
					};
				}
				return {
					content: [{
						type: 'text',
						text: `Branch "${slugifiedName}" already exists.`
					}]
				};
			}
			const source = from || 'HEAD';
			let createCmd = `git branch "${slugifiedName}" ${shellSingleQuote(source)}`;
			const createResult = await runGitCommand(createCmd, cwd);
			if (createResult.exitCode !== 0) {
				throw new Error(`Failed to create branch: ${createResult.output}`);
			}
			if (checkout) {
				const switchResult = await runGitCommand(`git checkout "${slugifiedName}"`, cwd);
				return {
					content: [{
						type: 'text',
						text: `Created and switched to branch "${slugifiedName}" from ${source}\n${switchResult.output}`
					}]
				};
			}
			return {
				content: [{
					type: 'text',
					text: `Created branch "${slugifiedName}" from ${source} (not checked out)`
				}]
			};
		} catch (error) {
			console.error('[create_branch_code] Error:', error);
			throw error;
		}
	});

	server.tool('get_blame_code', `Shows git blame (line-by-line authorship) for a file or line range.

WHEN TO USE: Understanding who wrote/changed specific code, finding when bugs were introduced.

Supports line ranges. Returns author, commit hash, date, and line content.`, {
		path: z.string().describe('File path relative to its workspace root; with multiple folders open, "FolderName/path" targets another folder'),
		startLine: z.number().optional().describe('Start line number (1-based, inclusive)'),
		endLine: z.number().optional().describe('End line number (1-based, inclusive)'),
		format: z.enum(['text', 'json']).optional().default('text').describe('Output format'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path, startLine, endLine, format = 'text', workspace }) => {
		try {
			const target = resolveRelativeToolPath(path, workspace);
			const fileCheck = await runGitCommand(`git ls-files "${target.gitPath}"`, target.root);
			if (fileCheck.exitCode !== 0 || !fileCheck.output.trim()) {
				throw new Error(`File not tracked by git: ${path}`);
			}
			let blameCmd = `git blame --line-porcelain "${target.gitPath}"`;
			if (startLine && endLine) {
				blameCmd = `git blame -L ${startLine},${endLine} --line-porcelain "${target.gitPath}"`;
			} else if (startLine) {
				blameCmd = `git blame -L ${startLine},${startLine} --line-porcelain "${target.gitPath}"`;
			}
			const result = await runGitCommand(blameCmd, target.root);
			if (result.exitCode !== 0) {
				throw new Error(`Git blame failed: ${result.output}`);
			}
			const lines = result.output.split('\n');
			const blameEntries: Array<{ sha: string; author: string; authorEmail: string; date: string; content: string; lineNumber: number }> = [];
			let currentEntry: any = {};
			for (const line of lines) {
				if (line.startsWith('author ')) {
					currentEntry.author = line.substring(7);
				} else if (line.startsWith('author-mail ')) {
					currentEntry.authorEmail = line.substring(12).replace(/[<>]/g, '');
				} else if (line.startsWith('author-time ')) {
					const timestamp = parseInt(line.substring(12)) * 1000;
					currentEntry.date = new Date(timestamp).toISOString().split('T')[0];
				} else if (/^[0-9a-f]{40}/.test(line)) {
					if (currentEntry.sha) {
						blameEntries.push(currentEntry);
					}
					const headerMatch = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)/);
					currentEntry = { sha: line.substring(0, 40), lineNumber: headerMatch ? parseInt(headerMatch[1], 10) : 0 };
				} else if (line.startsWith('\t')) {
					currentEntry.content = line.substring(1);
					currentEntry.lineNumber = currentEntry.lineNumber || 0;
				}
			}
			if (currentEntry.sha) {
				blameEntries.push(currentEntry);
			}
			if (format === 'json') {
				return {
					content: [{
						type: 'text',
						text: JSON.stringify(blameEntries, null, 2)
					}]
				};
			}
			let output = `Git blame for ${path}${startLine ? ` (lines ${startLine}-${endLine || startLine})` : ''}:\n\n`;
			for (const entry of blameEntries) {
				const shortSha = entry.sha.substring(0, 8);
				const date = entry.date || 'unknown';
				const author = entry.author || 'unknown';
				const content = entry.content || '';
				output += `${shortSha} ${author} (${date}) ${entry.lineNumber}: ${content}\n`;
			}
			return {
				content: [{ type: 'text', text: output }]
			};
		} catch (error) {
			console.error('[get_blame_code] Error:', error);
			throw error;
		}
	});

	server.tool('list_conflicts_code', `Lists all files with merge conflicts and shows conflict markers.

WHEN TO USE: After failed merge/rebase, before resolving conflicts.

Shows conflicted files and the actual conflict sections (<<<<<<< HEAD ... >>>>>>> branch).`, {
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ workspace }) => {
		try {
			const cwd = getWorkspaceRoot(workspace);
			const diffCheck = await runGitCommand('git diff --name-only --diff-filter=U', cwd);
			let conflictedFiles = diffCheck.output.split('\n').map(l => l.trim()).filter(l => l && !l.includes(' '));
			if (conflictedFiles.length === 0) {
				return {
					content: [{ type: 'text', text: 'No merge conflicts detected. Working tree clean.' }]
				};
			}
			let output = `Found ${conflictedFiles.length} conflicted file(s):\n\n`;
			for (const file of conflictedFiles) {
				output += `=== ${file} ===\n`;
				const fileContent = await runGitCommand(`cat "${file}"`, cwd);
				const lines = fileContent.output.split('\n');
				let inConflict = false;
				let conflictSection = '';
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.includes('<<<<<<<')) {
						inConflict = true;
						conflictSection = `${i + 1}: ${line}\n`;
					} else if (inConflict) {
						conflictSection += `${i + 1}: ${line}\n`;
						if (line.includes('>>>>>>>')) {
							output += conflictSection + '\n';
							inConflict = false;
						}
					}
				}
				if (inConflict) {
					output += conflictSection + '\n';
				}
			}
			return {
				content: [{ type: 'text', text: output }]
			};
		} catch (error) {
			console.error('[list_conflicts_code] Error:', error);
			throw error;
		}
	});

	server.tool('stash_changes_code', `Manages git stash: push, pop, list, drop, apply, show.

WHEN TO USE: Temporarily saving work-in-progress, switching branches cleanly, recovering stashed changes.

Default action: push with auto-generated WIP message.`, {
		action: z.enum(['push', 'pop', 'list', 'drop', 'apply', 'show']).optional().default('push').describe('Stash action to perform'),
		message: z.string().optional().describe('Custom stash message (for push)'),
		index: z.number().int().min(0).optional().default(0).describe('Stash index (for pop/drop/apply/show, 0=latest)'),
		includeUntracked: z.boolean().optional().default(false).describe('Include untracked files (git stash -u)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ action = 'push', message, index = 0, includeUntracked = false, workspace }) => {
		try {
			const cwd = getWorkspaceRoot(workspace);
			switch (action) {
				case 'list': {
					const result = await runGitCommand('git stash list', cwd);
					return {
						content: [{
							type: 'text',
							text: result.output || 'No stashes found.'
						}]
					};
				}
				case 'show': {
					const result = await runGitCommand(`git stash show -p 'stash@{${index}}'`, cwd);
					return {
						content: [{
							type: 'text',
							text: `Stash stash@{${index}}:\n\n${result.output || 'Empty or invalid stash.'}`
						}]
					};
				}
				case 'push': {
					const status = await runGitCommand('git status --porcelain', cwd);
					if (!status.output.trim() && !includeUntracked) {
						return {
							content: [{ type: 'text', text: 'No changes to stash. Working tree clean.' }]
						};
					}
					let stashMsg = message;
					if (!stashMsg) {
						const branch = await runGitCommand('git branch --show-current', cwd);
						const commit = await runGitCommand('git log -1 --pretty=format:"%h %s"', cwd);
						stashMsg = `WIP on ${branch.output.trim()}: ${commit.output.trim()}`;
					}
					let pushCmd = `git stash push -m ${shellSingleQuote(stashMsg)}`;
					if (includeUntracked) {
						pushCmd += ' -u';
					}
					const result = await runGitCommand(pushCmd, cwd);
					return {
						content: [{
							type: 'text',
							text: `Stashed changes: ${stashMsg}\n${result.output}`
						}]
					};
				}
				case 'pop': {
					const result = await runGitCommand(`git stash pop 'stash@{${index}}'`, cwd);
					return {
						content: [{
							type: 'text',
							text: `Popped stash@{${index}}\n${result.output}`
						}]
					};
				}
				case 'apply': {
					const result = await runGitCommand(`git stash apply 'stash@{${index}}'`, cwd);
					return {
						content: [{
							type: 'text',
							text: `Applied stash@{${index}} (stash retained)\n${result.output}`
						}]
					};
				}
				case 'drop': {
					const result = await runGitCommand(`git stash drop 'stash@{${index}}'`, cwd);
					return {
						content: [{
							type: 'text',
							text: `Dropped stash@{${index}}\n${result.output}`
						}]
					};
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		} catch (error) {
			console.error('[stash_changes_code] Error:', error);
			throw error;
		}
	});
}