import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveWorkspaceFolder, resolveRelativeToolPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { executeShellCommand } from './shell-tools';
import { getRecentAudit } from '../auth/audit';

const DEFAULT_EXCLUDES = [
	'**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.js',
	'**/*.map', '**/vendor/**', '**/.next/**', '**/target/**', '**/__pycache__/**'
];

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

async function getWorkspaceRoot(ref?: string): Promise<string> {
	return resolveWorkspaceFolder(ref).uri.fsPath;
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

const PLACEHOLDER_RE = /^(x+|y+|\.+|<[^>]+>|\$\{[^}]*\}|your[_-].*|example.*|changeme|dummy|placeholder.*|test.*|xxx+.*)$/i;

interface Finding { severity: 'high' | 'medium' | 'low'; kind: string; file: string; line: number; snippet: string }

function maskSecret(value: string): string {
	if (value.length <= 8) {
		return '*'.repeat(value.length);
	}
	return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}

const SECRET_PATTERNS: Array<{ name: string; severity: 'high' | 'medium'; regex: RegExp; secretGroup: number }> = [
	{ name: 'AWS Access Key ID', severity: 'high', regex: /\b(AKIA[0-9A-Z]{16})\b/, secretGroup: 1 },
	{ name: 'GitHub token', severity: 'high', regex: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/, secretGroup: 1 },
	{ name: 'Google API key', severity: 'high', regex: /\b(AIza[0-9A-Za-z_-]{35})\b/, secretGroup: 1 },
	{ name: 'Stripe live key', severity: 'high', regex: /\b((?:sk|pk|rk)_live_[0-9a-zA-Z]{16,})\b/, secretGroup: 1 },
	{ name: 'Slack token', severity: 'high', regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/, secretGroup: 1 },
	{ name: 'Private key block', severity: 'high', regex: /-----BEGIN\s(?:[A-Z ]+\s)?PRIVATE KEY(?: BLOCK)?-----/, secretGroup: -1 },
	{ name: 'JWT', severity: 'medium', regex: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/, secretGroup: 1 },
	{ name: 'Hardcoded credential', severity: 'medium', regex: /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i, secretGroup: 2 },
	{ name: 'AWS secret in config', severity: 'medium', regex: /aws.{0,30}['"]([0-9a-zA-Z/+]{40})['"]/i, secretGroup: 1 }
];

async function resolveScanTarget(optionsPath: string | undefined, workspace?: string): Promise<{ dir: string; displayPrefix: string }> {
	const target = resolveRelativeToolPath(optionsPath ?? '.', workspace);
	if (optionsPath !== undefined && !fs.existsSync(target.fsPath)) {
		throw new Error(`Path not found: ${optionsPath}`);
	}
	return { dir: target.dir, displayPrefix: target.displayBase };
}

async function findSecrets(options: { path?: string; exclude?: string[]; maxResults?: number; workspace?: string }): Promise<{ totalFiles: number; findings: Finding[] }> {
	const { dir: workspaceRoot, displayPrefix } = await resolveScanTarget(options.path, options.workspace);
	const excludeRegexes = (options.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);
	const maxResults = options.maxResults ?? 50;
	const files = collectFiles(workspaceRoot, excludeRegexes);
	const findings: Finding[] = [];

	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file.fullPath, 'utf-8');
		} catch {
			continue;
		}
		if (content.includes('\u0000')) {
			continue;
		}
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			for (const pattern of SECRET_PATTERNS) {
				const match = lines[i].match(pattern.regex);
				if (!match) {
					continue;
				}
				const secretValue = pattern.secretGroup > 0 ? match[pattern.secretGroup] : match[0];
				if (secretValue && PLACEHOLDER_RE.test(secretValue.trim())) {
					continue;
				}
				findings.push({
					severity: pattern.severity,
					kind: pattern.name,
					file: `${displayPrefix}${file.relativePath}`,
					line: i + 1,
					snippet: maskSecret(secretValue ?? '')
				});
				break;
			}
			if (findings.length >= maxResults) {
				return { totalFiles: files.length, findings };
			}
		}
	}
	return { totalFiles: files.length, findings };
}

interface Rule { id: string; severity: 'high' | 'medium' | 'low'; languages: Array<'js' | 'py'>; regex: RegExp }

const SECURITY_RULES: Rule[] = [
	{ id: 'js-eval', severity: 'high', languages: ['js'], regex: /\beval\s*\(/ },
	{ id: 'js-new-function', severity: 'high', languages: ['js'], regex: /new\s+Function\s*\(/ },
	{ id: 'js-innerhtml', severity: 'high', languages: ['js'], regex: /\.innerHTML\s*=|dangerouslySetInnerHTML/ },
	{ id: 'js-document-write', severity: 'medium', languages: ['js'], regex: /document\.write\s*\(/ },
	{ id: 'js-child-process-exec', severity: 'high', languages: ['js'], regex: /(child_process\.)?exec(Sync)?\s*\(\s*[`'"][^'"`]*[$]\{/ },
	{ id: 'js-tls-disabled', severity: 'high', languages: ['js'], regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized:\s*false/ },
	{ id: 'js-math-random-token', severity: 'low', languages: ['js'], regex: /(token|secret|password|otp|nonce)\s*[:=][^;\n]*Math\.random/i },
	{ id: 'js-settimeout-string', severity: 'medium', languages: ['js'], regex: /setTimeout\s*\(\s*['"]/ },
	{ id: 'js-sql-concat', severity: 'medium', languages: ['js'], regex: /['"`](?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^'"`]*(?:\$\{|'\s*\+)/i },
	{ id: 'py-eval-exec', severity: 'high', languages: ['py'], regex: /^\s*(?:eval|exec)\s*\(/ },
	{ id: 'py-yaml-load', severity: 'high', languages: ['py'], regex: /yaml\.load\s*\((?![^)]*Loader)/ },
	{ id: 'py-pickle-loads', severity: 'high', languages: ['py'], regex: /pickle\.loads?\s*\(/ },
	{ id: 'py-shell-true', severity: 'high', languages: ['py'], regex: /shell\s*=\s*True/ },
	{ id: 'py-tls-verify-off', severity: 'high', languages: ['py'], regex: /verify\s*=\s*False/ },
	{ id: 'py-hashlib-md5', severity: 'medium', languages: ['py'], regex: /hashlib\.md5\s*\(/ }
];

async function securityScan(options: { path?: string; severity?: 'high' | 'medium' | 'low'; maxResults?: number; workspace?: string }): Promise<{ totalFiles: number; findings: Finding[] }> {
	const { dir: workspaceRoot, displayPrefix } = await resolveScanTarget(options.path, options.workspace);
	const excludeRegexes = DEFAULT_EXCLUDES.map(globToRegExp);
	const maxResults = options.maxResults ?? 100;
	const severityRank = { high: 3, medium: 2, low: 1 };
	const minSeverity = options.severity ? severityRank[options.severity] : 1;
	const files = collectFiles(workspaceRoot, excludeRegexes)
		.filter(f => ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'].includes(path.extname(f.fullPath)));
	const findings: Finding[] = [];

	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file.fullPath, 'utf-8');
		} catch {
			continue;
		}
		const lang: 'js' | 'py' = path.extname(file.fullPath) === '.py' ? 'py' : 'js';
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i];
			if (/^\s*(\/\/|#|\*)/.test(lineText)) {
				continue;
			}
			for (const rule of SECURITY_RULES) {
				if (!rule.languages.includes(lang) || severityRank[rule.severity] < minSeverity) {
					continue;
				}
				if (rule.regex.test(lineText)) {
					findings.push({
						severity: rule.severity,
						kind: rule.id,
						file: `${displayPrefix}${file.relativePath}`,
						line: i + 1,
						snippet: lineText.trim().slice(0, 120)
					});
					break;
				}
			}
			if (findings.length >= maxResults) {
				return { totalFiles: files.length, findings };
			}
		}
	}
	return { totalFiles: files.length, findings };
}

function formatFindings(title: string, result: { totalFiles: number; findings: Finding[] }, showSnippet: boolean): string {
	const counts = { high: 0, medium: 0, low: 0 };
	for (const f of result.findings) {
		counts[f.severity] += 1;
	}
	if (result.findings.length === 0) {
		return `${title}\n\nNo issues found across ${result.totalFiles} files.`;
	}
	let output = `${title}\n\nScanned ${result.totalFiles} files. Findings: ${result.findings.length} (high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low})\n\n`;
	for (const f of result.findings.slice(0, 60)) {
		output += `[${f.severity.toUpperCase()}] ${f.kind} — ${f.file}:${f.line}${showSnippet ? `\n    ${f.snippet}` : ''}\n`;
	}
	if (result.findings.length > 60) {
		output += `... and ${result.findings.length - 60} more\n`;
	}
	return output;
}

let sharedTerminal: vscode.Terminal | undefined;

async function runShellCommand(command: string, workspace?: string): Promise<{ output: string; exitCode: number }> {
	if (!sharedTerminal) {
		throw new Error('Terminal not available for security tools');
	}
	const workspaceRoot = await getWorkspaceRoot(workspace);
	try {
		return await executeShellCommand(sharedTerminal, command, workspaceRoot, 60000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { output: message, exitCode: 1 };
	}
}

interface AuditAdvisory { module: string; severity: string; title: string; vulnerable: string; patched: string }

function parseNpmAudit(json: string): { counts: Record<string, number>; advisories: AuditAdvisory[] } | null {
	try {
		const data = JSON.parse(json);
		if (!data.metadata?.vulnerabilities && !data.vulnerabilities) {
			return null;
		}
		const counts = data.metadata?.vulnerabilities ?? {};
		const advisories: AuditAdvisory[] = [];
		const vulnerabilities = data.vulnerabilities ?? {};
		for (const [name, info] of Object.entries<any>(vulnerabilities)) {
			const via = Array.isArray(info.via) ? info.via.filter((v: any) => typeof v === 'object') : [];
			for (const v of via) {
				advisories.push({
					module: name,
					severity: v.severity ?? 'unknown',
					title: v.title ?? '',
					vulnerable: (info.range as string) ?? '',
					patched: Array.isArray(v.range) ? '' : (v.range as string) ?? ''
				});
			}
		}
		return { counts, advisories };
	} catch {
		return null;
	}
}

export function registerSecurityTools(server: McpServer, terminal?: vscode.Terminal): void {
	sharedTerminal = terminal;

	server.tool('get_audit_log_code', `Reads the security audit log: recent tool calls, denied tools, blocked shell commands, sandbox violations, consent grants and token revocations.

WHEN TO USE: to review what connected clients did on this machine, or to investigate suspicious activity.`, {
		limit: z.number().int().min(1).max(500).optional().default(50).describe('Maximum entries to return'),
		kind: z.enum(['tool_call', 'tool_denied', 'shell_blocked', 'sandbox_violation', 'consent_granted', 'consent_denied', 'token_revoked']).optional().describe('Filter by event kind')
	}, async ({ limit = 50, kind }) => {
		const events = getRecentAudit(limit, kind ? { kind } : undefined);
		if (events.length === 0) {
			return { content: [{ type: 'text' as const, text: 'Audit log is empty for this filter.' }] };
		}
		const lines = events.map(e => {
			const t = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
			return `${t}  [${e.kind}]  ${e.client}: ${e.detail}`;
		});
		return { content: [{ type: 'text' as const, text: `Audit log (${events.length} entries, newest first):\n\n${lines.join('\n')}` }] };
	});

	server.tool('find_secrets_code', `Scans the workspace for hardcoded secrets: AWS keys, GitHub/Slack tokens, Google API keys, Stripe live keys, private key blocks, JWTs and generic credential assignments.

WHEN TO USE: before committing or publishing, verifying that no credentials leaked into source or config files.

Matched values are masked in the output. Obvious placeholders ("your-api-key", "xxxx") are ignored.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
		maxResults: z.number().int().min(1).max(500).optional().default(50).describe('Maximum findings to report'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, exclude, maxResults, workspace }) => {
		const result = await findSecrets({ path: searchPath, exclude, maxResults, workspace });

		return { content: [{ type: 'text', text: formatFindings('# Secret Scan', result, true) }] };
	});

	server.tool('security_scan_code', `Scans source code for risky constructs: eval/new Function, innerHTML sinks, shell-injection-prone exec calls with interpolated input, disabled TLS verification, yaml.load without a safe Loader, pickle deserialization, shell=True subprocesses, SQL built by string concatenation.

WHEN TO USE: security review before a release, auditing AI-generated code, checking legacy modules.`, {
		path: z.string().optional().describe('Subdirectory to scan (default: whole workspace)'),
		severity: z.enum(['high', 'medium', 'low']).optional().describe('Minimum severity to report'),
		maxResults: z.number().int().min(1).max(500).optional().default(100).describe('Maximum findings to report'),
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ path: searchPath, severity, maxResults, workspace }) => {
		const result = await securityScan({ path: searchPath, severity, maxResults, workspace });
		return { content: [{ type: 'text', text: formatFindings('# Security Scan', result, true) }] };
	});

	server.tool('check_dependencies_vulnerabilities_code', `Runs npm audit against the workspace package-lock.json and reports known vulnerabilities per dependency with severities and patched versions.

WHEN TO USE: dependency review during releases, triaging CI audit failures. Requires network access to the npm registry.`, {
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ workspace }) => {
		const workspaceRoot = await getWorkspaceRoot(workspace);
		if (!fs.existsSync(path.join(workspaceRoot, 'package-lock.json')) && !fs.existsSync(path.join(workspaceRoot, 'package.json'))) {
			return { content: [{ type: 'text', text: 'No package.json/package-lock.json in the workspace — nothing to audit.' }] };
		}
		const { output, exitCode } = await runShellCommand('npm audit --json --no-audit-fund', workspace);
		if (exitCode !== 0 && !output.trim().startsWith('{')) {
			return { content: [{ type: 'text', text: `npm audit failed: ${output.slice(0, 500)}` }] };
		}
		const parsed = parseNpmAudit(output);
		if (!parsed) {
			return { content: [{ type: 'text', text: `Could not parse npm audit output: ${output.slice(0, 300)}` }] };
		}
		const c = parsed.counts;
		const total = (c.info ?? 0) + (c.low ?? 0) + (c.moderate ?? 0) + (c.high ?? 0) + (c.critical ?? 0);
		if (total === 0) {
			return { content: [{ type: 'text', text: 'npm audit found 0 vulnerabilities.' }] };
		}
		let text = `npm audit: ${total} vulnerabilit(ies) (critical: ${c.critical ?? 0}, high: ${c.high ?? 0}, moderate: ${c.moderate ?? 0}, low: ${c.low ?? 0}, info: ${c.info ?? 0})\n\n`;
		for (const adv of parsed.advisories.slice(0, 40)) {
			text += `[${String(adv.severity).toUpperCase()}] ${adv.module}: ${adv.title}`;
			if (adv.patched) {
				text += ` — fix available: ${adv.patched}`;
			}
			text += `\n`;
		}
		if (parsed.advisories.length > 40) {
			text += `... and ${parsed.advisories.length - 40} more\n`;
		}
		return { content: [{ type: 'text', text }] };
	});
}
