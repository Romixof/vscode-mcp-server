import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeShellCommand } from './shell-tools';

function requireWorkspaceFolder(): vscode.WorkspaceFolder {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		throw new Error('No workspace folder is open');
	}
	return vscode.workspace.workspaceFolders[0];
}

async function detectTestFramework(): Promise<{ framework: string; command: string; coverageFlag: string }> {
	if (!vscode.workspace.workspaceFolders) {
		throw new Error('No workspace folder is open');
	}
	const workspaceFolder = vscode.workspace.workspaceFolders[0];
	const workspaceUri = workspaceFolder.uri;
	const packageJsonUri = vscode.Uri.joinPath(workspaceUri, 'package.json');
	let packageJson: any = {};
	try {
		const content = await vscode.workspace.fs.readFile(packageJsonUri);
		packageJson = JSON.parse(Buffer.from(content).toString('utf-8'));
	} catch { }
	const scripts = packageJson.scripts || {};
	const devDeps = { ...packageJson.devDependencies, ...packageJson.dependencies };
	if (devDeps.vitest || scripts.test?.includes('vitest')) {
		return { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
	}
	if (devDeps.jest || scripts.test?.includes('jest')) {
		return { framework: 'jest', command: 'npx jest', coverageFlag: '--coverage' };
	}
	const requirementsUri = vscode.Uri.joinPath(workspaceUri, 'requirements.txt');
	let hasPytest = false;
	try {
		const content = await vscode.workspace.fs.readFile(requirementsUri);
		hasPytest = content.toString().includes('pytest');
	} catch { }
	if (!hasPytest) {
		// checked independently of requirements.txt — pytest may only be declared
		// in pyproject.toml ([project.optional-dependencies], [dependency-groups])
		const pyprojectUri = vscode.Uri.joinPath(workspaceUri, 'pyproject.toml');
		try {
			const content = await vscode.workspace.fs.readFile(pyprojectUri);
			hasPytest = content.toString().includes('pytest');
		} catch { }
	}
	if (hasPytest || scripts.test?.includes('pytest')) {
		return { framework: 'pytest', command: 'python -m pytest', coverageFlag: '--cov=.' };
	}
	if (devDeps.mocha || scripts.test?.includes('mocha')) {
		return { framework: 'mocha', command: 'npx mocha', coverageFlag: '' };
	}
	if (devDeps['@playwright/test'] || scripts.test?.includes('playwright')) {
		return { framework: 'playwright', command: 'npx playwright test', coverageFlag: '' };
	}
	if (devDeps.cypress || scripts.test?.includes('cypress')) {
		return { framework: 'cypress', command: 'npx cypress run', coverageFlag: '' };
	}
	return { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
}

async function detectFormatter(filePath: string): Promise<{ formatter: string; command: string }> {
	const ext = path.extname(filePath).toLowerCase();
	if (!vscode.workspace.workspaceFolders) {
		throw new Error('No workspace folder is open');
	}
	const workspaceFolder = vscode.workspace.workspaceFolders[0];
	const workspaceUri = workspaceFolder.uri;
	// language-specific formatters first — prettier can't parse .py/.rs/.go
	// and would otherwise win whenever any prettier config exists in the repo
	switch (ext) {
		case '.py': {
			try {
				const reqUri = vscode.Uri.joinPath(workspaceUri, 'requirements.txt');
				const content = await vscode.workspace.fs.readFile(reqUri);
				const text = content.toString();
				if (text.includes('black')) {
					return { formatter: 'black', command: `black "${filePath}"` };
				}
				if (text.includes('ruff')) {
					return { formatter: 'ruff', command: `ruff format "${filePath}"` };
				}
			} catch { }
			return { formatter: 'black', command: `black "${filePath}"` };
		}
		case '.rs':
			return { formatter: 'rustfmt', command: `rustfmt "${filePath}"` };
		case '.go':
			return { formatter: 'gofmt', command: `gofmt -w "${filePath}"` };
	}
	const prettierConfigs = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js'];
	for (const config of prettierConfigs) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, config));
			return { formatter: 'prettier', command: `npx prettier --write "${filePath}"` };
		} catch { }
	}
	try {
		const pkgUri = vscode.Uri.joinPath(workspaceUri, 'package.json');
		const content = await vscode.workspace.fs.readFile(pkgUri);
		const pkg = JSON.parse(Buffer.from(content).toString('utf-8'));
		if (pkg.devDependencies?.prettier || pkg.dependencies?.prettier) {
			return { formatter: 'prettier', command: `npx prettier --write "${filePath}"` };
		}
	} catch { }
	return { formatter: 'prettier', command: `npx prettier --write "${filePath}"` };
}

async function detectLinter(filePath?: string): Promise<{ linter: string; command: string; fixFlag: string }> {
	if (!vscode.workspace.workspaceFolders) {
		throw new Error('No workspace folder is open');
	}
	const workspaceFolder = vscode.workspace.workspaceFolders[0];
	const workspaceUri = workspaceFolder.uri;
	// Python targets resolve to a Python linter even when an eslint config
	// exists elsewhere in the repo (mixed monorepos) — eslint can't parse .py
	const isPythonTarget = !!filePath && filePath.toLowerCase().endsWith('.py');
	if (!isPythonTarget) {
		const eslintConfigs = ['.eslintrc', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js'];
		for (const config of eslintConfigs) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, config));
				return { linter: 'eslint', command: `npx eslint`, fixFlag: '--fix' };
			} catch { }
		}
		try {
			const pkgUri = vscode.Uri.joinPath(workspaceUri, 'package.json');
			const content = await vscode.workspace.fs.readFile(pkgUri);
			const pkg = JSON.parse(Buffer.from(content).toString('utf-8'));
			if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
				return { linter: 'eslint', command: `npx eslint`, fixFlag: '--fix' };
			}
		} catch { }
	} else {
		try {
			const reqUri = vscode.Uri.joinPath(workspaceUri, 'requirements.txt');
			const content = await vscode.workspace.fs.readFile(reqUri);
			const text = content.toString();
			if (text.includes('ruff')) {
				return { linter: 'ruff', command: `ruff check`, fixFlag: '--fix' };
			}
			if (text.includes('flake8')) {
				return { linter: 'flake8', command: `flake8`, fixFlag: '' };
			}
			if (text.includes('pylint')) {
				return { linter: 'pylint', command: `pylint`, fixFlag: '' };
			}
		} catch { }
		return { linter: 'ruff', command: `ruff check`, fixFlag: '--fix' };
	}
	return { linter: 'eslint', command: `npx eslint`, fixFlag: '--fix' };
}

async function getGitDiff(filePath?: string): Promise<string> {
	if (!vscode.workspace.workspaceFolders) {
		throw new Error('No workspace folder is open');
	}
	const workspaceFolder = vscode.workspace.workspaceFolders[0];
	const cwd = workspaceFolder.uri.fsPath;
	let command = 'git diff';
	if (filePath) {
		command = `git diff "${filePath}"`;
	}
	const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Git Diff');
	const { output } = await executeShellCommand(terminal, command, cwd, 10000);
	return output;
}

export function registerTestTools(server: McpServer): void {
	server.tool('run_tests_code', `Runs tests using the detected test framework (vitest, jest, pytest, mocha, playwright, cypress).

WHEN TO USE: Running test suites, validating changes, CI simulation.

Auto-detects framework from package.json/requirements.txt. Supports filtering by file/pattern.
Returns stdout/stderr with pass/fail summary.`, {
		pattern: z.string().optional().describe('Optional test file pattern or path to run specific tests'),
		framework: z.enum(['auto', 'vitest', 'jest', 'pytest', 'mocha', 'playwright', 'cypress']).optional().default('auto').describe('Force specific framework (default: auto-detect)'),
		args: z.string().optional().describe('Additional arguments to pass to the test command'),
		cwd: z.string().optional().default('.').describe('Working directory (default: workspace root)')
	}, async ({ pattern, framework = 'auto', args = '', cwd = '.' }) => {
		try {
			let detected = { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
			if (framework === 'auto') {
				detected = await detectTestFramework();
			} else {
				const commands: Record<string, { command: string; coverageFlag: string }> = {
					vitest: { command: 'npx vitest run', coverageFlag: '--coverage' },
					jest: { command: 'npx jest', coverageFlag: '--coverage' },
					pytest: { command: 'python -m pytest', coverageFlag: '--cov=.' },
					mocha: { command: 'npx mocha', coverageFlag: '' },
					playwright: { command: 'npx playwright test', coverageFlag: '' },
					cypress: { command: 'npx cypress run', coverageFlag: '' }
				};
				detected = { framework, ...commands[framework] };
			}
			let command = detected.command;
			if (pattern) {
				// quoted for every framework — patterns with spaces otherwise split
				// into unrelated filters (playwright/cypress/mocha)
				command += ` "${pattern}"`;
			}
			if (args) {
				command += ` ${args}`;
			}
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Tests');
			const workspaceFolder = requireWorkspaceFolder();
			const fullCwd = path.resolve(workspaceFolder.uri.fsPath, cwd);
			const { output } = await executeShellCommand(terminal, command, fullCwd, 120000);
			return {
				content: [{
					type: 'text',
					text: `Framework: ${detected.framework}\nCommand: ${command}\n\nOutput:\n${output}`
				}]
			};
		} catch (error) {
			console.error('[run_tests_code] Error:', error);
			throw error;
		}
	});

	server.tool('get_test_coverage_code', `Generates test coverage report for the project or specific files.

WHEN TO USE: Checking coverage before commits, identifying untested code, CI reports.

Runs tests with coverage flag. Returns summary and detailed report if available.
Supports: vitest, jest, pytest (with pytest-cov), mocha (with c8/nyc).`, {
		path: z.string().optional().describe('Optional file or directory path to get coverage for'),
		format: z.enum(['text', 'json', 'lcov', 'html']).optional().default('text').describe('Output format for coverage report'),
		framework: z.enum(['auto', 'vitest', 'jest', 'pytest', 'mocha']).optional().default('auto').describe('Force specific framework (default: auto-detect)')
	}, async ({ path: targetPath, format = 'text', framework = 'auto' }) => {
		try {
			let detected = { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
			if (framework === 'auto') {
				detected = await detectTestFramework();
			} else {
				const commands: Record<string, { command: string; coverageFlag: string }> = {
					vitest: { command: 'npx vitest run', coverageFlag: '--coverage' },
					jest: { command: 'npx jest', coverageFlag: '--coverage' },
					pytest: { command: 'python -m pytest', coverageFlag: '--cov=.' },
					mocha: { command: 'npx mocha', coverageFlag: '' }
				};
				detected = { framework, ...commands[framework] };
			}
			let command = `${detected.command} ${detected.coverageFlag}`;
			if (detected.framework === 'mocha') {
				// mocha has no native coverage — wrap in c8 or no report is produced
				command = `npx c8 ${command}`;
			}
			if (detected.framework === 'vitest') {
				if (format === 'json') {
					command += ` --coverage.reporter=json`;
				} else if (format === 'lcov') {
					command += ` --coverage.reporter=lcov`;
				} else if (format === 'html') {
					command += ` --coverage.reporter=html`;
				}
			} else if (detected.framework === 'jest') {
				if (format === 'json') {
					command += ` --coverageReporters=json`;
				} else if (format === 'lcov') {
					command += ` --coverageReporters=lcov`;
				} else if (format === 'html') {
					command += ` --coverageReporters=html`;
				}
			} else if (detected.framework === 'pytest') {
				if (format === 'json') {
					command += ` --cov-report=json`;
				} else if (format === 'html') {
					command += ` --cov-report=html`;
				} else {
					command += ` --cov-report=term-missing`;
				}
			}
			if (targetPath) {
				if (detected.framework === 'pytest') {
					command += ` "${targetPath}"`;
				} else if (detected.framework === 'vitest') {
					command += ` --coverage.include="${targetPath}"`;
				} else if (detected.framework === 'jest') {
					command += ` --collectCoverageFrom="${targetPath}"`;
				}
			}
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Coverage');
			const workspaceFolder = requireWorkspaceFolder();
			const cwd = workspaceFolder.uri.fsPath;
			const { output } = await executeShellCommand(terminal, command, cwd, 180000);
			return {
				content: [{
					type: 'text',
					text: `Framework: ${detected.framework}\nFormat: ${format}\nCommand: ${command}\n\nCoverage Output:\n${output}`
				}]
			};
		} catch (error) {
			console.error('[get_test_coverage_code] Error:', error);
			throw error;
		}
	});

	server.tool('format_document_code', `Formats a file using the appropriate formatter (Prettier, Black, rustfmt, gofmt, ruff, etc.).

WHEN TO USE: Auto-formatting code before commits, fixing style inconsistencies.

Auto-detects formatter from config files (prettierrc, pyproject.toml, etc.) and file extension.
Returns formatted content or success confirmation.`, {
		path: z.string().describe('Path to the file to format'),
		formatter: z.enum(['auto', 'prettier', 'black', 'ruff', 'rustfmt', 'gofmt']).optional().default('auto').describe('Force specific formatter (default: auto-detect)'),
		checkOnly: z.boolean().optional().default(false).describe('Only check if formatting is needed, do not write changes')
	}, async ({ path: filePath, formatter = 'auto', checkOnly = false }) => {
		try {
			const workspaceFolder = requireWorkspaceFolder();
			const workspaceUri = workspaceFolder.uri;
			// absolute paths resolve against the filesystem, not under the workspace
			const fileUri = path.isAbsolute(filePath) ? vscode.Uri.file(filePath) : vscode.Uri.joinPath(workspaceUri, filePath);
			try {
				await vscode.workspace.fs.stat(fileUri);
			} catch {
				throw new Error(`File not found: ${filePath}`);
			}
			let detected = { formatter: 'prettier', command: `npx prettier --write "${filePath}"` };
			if (formatter === 'auto') {
				detected = await detectFormatter(filePath);
			} else {
				const formatters: Record<string, { command: string }> = {
					prettier: { command: `npx prettier --write "${filePath}"` },
					black: { command: `black "${filePath}"` },
					ruff: { command: `ruff format "${filePath}"` },
					rustfmt: { command: `rustfmt "${filePath}"` },
					gofmt: { command: `gofmt -w "${filePath}"` }
				};
				detected = { formatter, ...formatters[formatter] };
			}
			let command = detected.command;
			if (checkOnly) {
				if (detected.formatter === 'prettier') {
					command = command.replace('--write', '--check');
				} else if (detected.formatter === 'black') {
					command = command.replace('black', 'black --check');
				} else if (detected.formatter === 'ruff') {
					command = command.replace('format', 'format --check');
				} else if (detected.formatter === 'rustfmt') {
					command = command.replace('rustfmt', 'rustfmt --check');
				} else if (detected.formatter === 'gofmt') {
					command = command.replace('gofmt -w', 'gofmt -d');
				}
			}
			const originalContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Format');
			const cwd = workspaceFolder.uri.fsPath;
			const { output } = await executeShellCommand(terminal, command, cwd, 30000);
			let newContent = originalContent;
			if (!checkOnly) {
				try {
					newContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
				} catch { }
			}
			const changed = originalContent !== newContent;
			// cap the before/after excerpt — dumping two full copies of a large file
			// floods the model context and buries real changes
			const MAX_EXCERPT_LINES = 100;
			let excerpt = '';
			if (changed && !checkOnly) {
				const before = originalContent.split('\n');
				const after = newContent.split('\n');
				const beforeExcerpt = before.length > MAX_EXCERPT_LINES ? [...before.slice(0, MAX_EXCERPT_LINES), `… (${before.length - MAX_EXCERPT_LINES} more lines)`] : before;
				const afterExcerpt = after.length > MAX_EXCERPT_LINES ? [...after.slice(0, MAX_EXCERPT_LINES), `… (${after.length - MAX_EXCERPT_LINES} more lines)`] : after;
				excerpt = `\n\n--- Before ---\n${beforeExcerpt.join('\n')}\n\n--- After ---\n${afterExcerpt.join('\n')}`;
			}
			return {
				content: [{
					type: 'text',
					text: `Formatter: ${detected.formatter}\nFile: ${filePath}\nCheck-only: ${checkOnly}\nChanged: ${changed}\n\n${output}${excerpt}`
				}]
			};
		} catch (error) {
			console.error('[format_document_code] Error:', error);
			throw error;
		}
	});

	server.tool('lint_and_fix_code', `Runs linter with auto-fix for the project or specific file (ESLint, ruff, flake8, pylint).

WHEN TO USE: Fixing linting errors automatically, cleaning up code before commits.

Auto-detects linter from config files. Returns fixed issues summary.`, {
		path: z.string().optional().describe('Optional file or directory to lint (default: entire workspace)'),
		linter: z.enum(['auto', 'eslint', 'ruff', 'flake8', 'pylint']).optional().default('auto').describe('Force specific linter (default: auto-detect)'),
		fix: z.boolean().optional().default(true).describe('Apply auto-fixes (default: true)')
	}, async ({ path: targetPath, linter = 'auto', fix = true }) => {
		try {
			let detected = { linter: 'eslint', command: 'npx eslint', fixFlag: '--fix' };
			if (linter === 'auto') {
				detected = await detectLinter(targetPath);
			} else {
				const linters: Record<string, { command: string; fixFlag: string }> = {
					eslint: { command: 'npx eslint', fixFlag: '--fix' },
					ruff: { command: 'ruff check', fixFlag: '--fix' },
					flake8: { command: 'flake8', fixFlag: '' },
					pylint: { command: 'pylint', fixFlag: '' }
				};
				detected = { linter, ...linters[linter] };
			}
			let command = detected.command;
			if (fix && detected.fixFlag) {
				command += ` ${detected.fixFlag}`;
			}
			if (targetPath) {
				command += ` "${targetPath}"`;
			}
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Lint');
			const workspaceFolder = requireWorkspaceFolder();
			const cwd = workspaceFolder.uri.fsPath;
			const { output } = await executeShellCommand(terminal, command, cwd, 60000);
			return {
				content: [{
					type: 'text',
					text: `Linter: ${detected.linter}\nTarget: ${targetPath || 'entire workspace'}\nFix mode: ${fix}\nCommand: ${command}\n\nOutput:\n${output}`
				}]
			};
		} catch (error) {
			console.error('[lint_and_fix_code] Error:', error);
			throw error;
		}
	});

	server.tool('get_git_diff_code', `Shows git diff for the current file, staged changes, or entire repository.

WHEN TO USE: Reviewing changes before commit, seeing what modified, debugging.

Shows unstaged changes by default. Use staged=true for staged changes.`, {
		path: z.string().optional().describe('Optional file path to show diff for (default: all changes)'),
		staged: z.boolean().optional().default(false).describe('Show staged (cached) changes instead of unstaged'),
		noColor: z.boolean().optional().default(true).describe('Disable ANSI color codes in output')
	}, async ({ path: filePath, staged = false, noColor = true }) => {
		try {
			if (!vscode.workspace.workspaceFolders) {
				throw new Error('No workspace folder is open');
			}
			const workspaceFolder = vscode.workspace.workspaceFolders[0];
			const cwd = workspaceFolder.uri.fsPath;
			let command = staged ? 'git diff --cached' : 'git diff';
			if (noColor) {
				command = 'git -c color.ui=never ' + command.replace('git ', '');
			}
			if (filePath) {
				command += ` "${filePath}"`;
			}
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Git Diff');
			const { output } = await executeShellCommand(terminal, command, cwd, 10000);
			if (!output.trim()) {
				return {
					content: [{
						type: 'text',
						text: staged
							? 'No staged changes.'
							: filePath
								? `No changes in ${filePath}`
								: 'No changes in repository.'
					}]
				};
			}
			return {
				content: [{
					type: 'text',
					text: `${staged ? 'Staged' : 'Unstaged'} changes${filePath ? ` in ${filePath}` : ''}:\n\n${output}`
				}]
			};
		} catch (error) {
			console.error('[get_git_diff_code] Error:', error);
			throw error;
		}
	});
}