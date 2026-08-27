import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeShellCommand } from './shell-tools';
import { resolveWorkspaceFolder, resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

async function detectTestFramework(workspace?: string): Promise<{ framework: string; command: string; coverageFlag: string }> {
	const workspaceUri = resolveWorkspaceFolder(workspace).uri;
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

async function detectFormatter(filePath: string, workspace?: string): Promise<{ formatter: string; command: string }> {
	const ext = path.extname(filePath).toLowerCase();
	const workspaceUri = resolveWorkspaceFolder(workspace).uri;

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

async function detectLinter(filePath?: string, workspace?: string): Promise<{ linter: string; command: string; fixFlag: string }> {
	const workspaceUri = resolveWorkspaceFolder(workspace).uri;

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

export function registerTestTools(server: McpServer): void {
	server.tool('run_tests_code', `Run tests (auto-detects framework).`, {
		pattern: z.string().optional().describe('Optional test file pattern or path to run specific tests'),
		framework: z.enum(['auto', 'vitest', 'jest', 'pytest', 'mocha', 'playwright', 'cypress']).optional().default('auto').describe('Force specific framework (default: auto-detect)'),
		args: z.string().optional().describe('Additional arguments to pass to the test command'),
		cwd: z.string().optional().default('.').describe('Working directory (default: workspace root)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ pattern, framework = 'auto', args = '', cwd = '.', workspace }) => {
		try {
			let detected = { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
			if (framework === 'auto') {
				detected = await detectTestFramework(workspace);
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

				command += ` "${pattern}"`;
			}
			if (args) {
				command += ` ${args}`;
			}
			const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Tests');
			const fullCwd = path.resolve(resolveWorkspaceFolder(workspace).uri.fsPath, cwd);
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

	server.tool('get_test_coverage_code', `Generate test coverage report.`, {
		path: z.string().optional().describe('Optional file or directory path to get coverage for'),
		format: z.enum(['text', 'json', 'lcov', 'html']).optional().default('text').describe('Output format for coverage report'),
		framework: z.enum(['auto', 'vitest', 'jest', 'pytest', 'mocha']).optional().default('auto').describe('Force specific framework (default: auto-detect)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: targetPath, format = 'text', framework = 'auto', workspace }) => {
		try {
			let detected = { framework: 'vitest', command: 'npx vitest run', coverageFlag: '--coverage' };
			if (framework === 'auto') {
				detected = await detectTestFramework(workspace);
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
			const cwd = resolveWorkspaceFolder(workspace).uri.fsPath;
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

	server.tool('format_document_code', `Format a file (prettier/black/etc).`, {
		path: z.string().describe('Path to the file to format'),
		formatter: z.enum(['auto', 'prettier', 'black', 'ruff', 'rustfmt', 'gofmt']).optional().default('auto').describe('Force specific formatter (default: auto-detect)'),
		checkOnly: z.boolean().optional().default(false).describe('Only check if formatting is needed, do not write changes'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: filePath, formatter = 'auto', checkOnly = false, workspace }) => {
		try {

			const target = resolveRelativeToolPath(filePath, workspace);
			const fileUri = vscode.Uri.file(target.fsPath);
			try {
				await vscode.workspace.fs.stat(fileUri);
			} catch {
				throw new Error(`File not found: ${filePath}`);
			}
			let detected = { formatter: 'prettier', command: `npx prettier --write "${filePath}"` };
			if (formatter === 'auto') {
				detected = await detectFormatter(target.fsPath, workspace);
			} else {
				const formatters: Record<string, { command: string }> = {
					prettier: { command: `npx prettier --write "${target.fsPath}"` },
					black: { command: `black "${target.fsPath}"` },
					ruff: { command: `ruff format "${target.fsPath}"` },
					rustfmt: { command: `rustfmt "${target.fsPath}"` },
					gofmt: { command: `gofmt -w "${target.fsPath}"` }
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
			const cwd = resolveWorkspaceFolder(workspace).uri.fsPath;
			const { output } = await executeShellCommand(terminal, command, cwd, 30000);
			let newContent = originalContent;
			if (!checkOnly) {
				try {
					newContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
				} catch { }
			}
			const changed = originalContent !== newContent;

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

	server.tool('lint_and_fix_code', `Lint and auto-fix (eslint/ruff/etc).`, {
		path: z.string().optional().describe('Optional file or directory to lint (default: entire workspace)'),
		linter: z.enum(['auto', 'eslint', 'ruff', 'flake8', 'pylint']).optional().default('auto').describe('Force specific linter (default: auto-detect)'),
		fix: z.boolean().optional().default(true).describe('Apply auto-fixes (default: true)'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: targetPath, linter = 'auto', fix = true, workspace }) => {
		try {
			let detected = { linter: 'eslint', command: 'npx eslint', fixFlag: '--fix' };
			if (linter === 'auto') {
				detected = await detectLinter(targetPath, workspace);
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
			const cwd = resolveWorkspaceFolder(workspace).uri.fsPath;
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

	server.tool('get_git_diff_code', `Show git diff.`, {
		path: z.string().optional().describe('Optional file path to show diff for (default: all changes)'),
		staged: z.boolean().optional().default(false).describe('Show staged (cached) changes instead of unstaged'),
		noColor: z.boolean().optional().default(true).describe('Disable ANSI color codes in output'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: filePath, staged = false, noColor = true, workspace }) => {
		try {
			let cwd = resolveWorkspaceFolder(workspace).uri.fsPath;
			let command = staged ? 'git diff --cached' : 'git diff';
			if (noColor) {
				command = 'git -c color.ui=never ' + command.replace('git ', '');
			}
			if (filePath) {

				const target = resolveRelativeToolPath(filePath, workspace);
				cwd = target.root;
				command += ` "${target.gitPath}"`;
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