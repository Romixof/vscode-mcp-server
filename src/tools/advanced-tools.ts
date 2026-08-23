import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { getUsageSnapshot, getTotalCalls, getServerStartTime } from '../utils/usage';

export const EXTENSION_ID = 'Romixo.vscode-mcp-server';

interface ExtensionSummary {
	id: string;
	version: string;
	description: string;
}

/**
 * Lists installed extensions, optionally skipping the built-in vscode.* ones.
 */
function collectInstalledExtensions(includeBuiltins: boolean): ExtensionSummary[] {
	return vscode.extensions.all
		.filter(ext => includeBuiltins || !ext.id.startsWith('vscode.'))
		.map(ext => ({
			id: ext.id,
			version: ext.packageJSON?.version ?? '?',
			description: String(ext.packageJSON?.description ?? '')
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Reads the team's recommended extension ids from .vscode/extensions.json.
 * Tolerates comments and missing files.
 */
function readWorkspaceRecommendations(root: string): string[] {
	try {
		const file = path.join(root, '.vscode', 'extensions.json');
		const raw = fs.readFileSync(file, 'utf-8');
		// A bloated recommendations file is not worth stalling the extension
		// host over; checking the buffer avoids a stat/read race on the cap
		if (Buffer.byteLength(raw) > 1024 * 1024) {
			return [];
		}
		const stripped = raw
			.split('\n')
			.filter(line => !line.trim().startsWith('//'))
			.join('\n')
			.replace(/\/\*[\s\S]*?\*\//g, '');
		const parsed = JSON.parse(stripped);
		const ids = parsed?.recommendations;
		return Array.isArray(ids) ? ids.map(String) : [];
	} catch {
		return [];
	}
}

function formatExtensionList(title: string, extensions: ExtensionSummary[]): string {
	if (extensions.length === 0) {
		return `${title}: none.`;
	}
	const lines = extensions.map(ext => `- ${ext.id} @ ${ext.version}${ext.description ? ` — ${ext.description}` : ''}`);
	return `${title} (${extensions.length}):\n${lines.join('\n')}`;
}

/**
 * Registers MCP advanced tools (server introspection and extension inventory)
 * @param server MCP server instance
 * @param endpoint host:port the HTTP server binds, for display purposes
 */
export function registerAdvancedTools(server: McpServer, endpoint: { host: string; port: number }, clusterInfo?: () => string | undefined): void {
	server.tool(
		'get_server_info_code',
		`Reports this MCP server's own status: extension/VS Code/Node versions, platform, remote environment (devcontainer / WSL / SSH), open workspace folders, uptime, and how many times each tool has been called since activation.

        WHEN TO USE: Debugging connectivity ("is it running? where?"), checking which remote the client must reach, reviewing what an agent session has been doing.

        All counters are local to your machine; nothing is sent anywhere.`,
		{},
		async (): Promise<CallToolResult> => {
			const folders = listWorkspaceFolders();
			const usage = getUsageSnapshot().slice(0, 20);
			const uptimeSeconds = Math.round((Date.now() - getServerStartTime()) / 1000);
			const remoteName = (vscode.env as { remoteName?: string | undefined }).remoteName;

			const lines = [
				'Server status',
				`- Endpoint: http://${endpoint.host}:${endpoint.port}/mcp`,
				`- Extension version: ${vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version ?? 'unknown'}`,
				`- VS Code version: ${vscode.version}`,
				`- Node version: ${process.version}`,
				`- Platform: ${process.platform}`,
				`- Environment: ${remoteName ? `remote "${remoteName}" — clients on another machine need port forwarding or a connection inside this remote` : 'local'}`,
				`- Open workspace folders (${folders.length}): ${folders.length ? folders.map((f, i) => `${i + 1}=${f.name}`).join(', ') : 'none'}`,
				`- Uptime: ${uptimeSeconds}s`,
				`- Tool calls since activation: ${getTotalCalls()}`
			];
			if (usage.length > 0) {
				lines.push('- Top tools: ' + usage.map(u => `${u.tool} (${u.calls})`).join(', '));
			}
			const clusterLine = clusterInfo?.();
			if (clusterLine) {
				lines.push(clusterLine);
			}
			return { content: [{ type: 'text', text: lines.join('\n') }] };
		}
	);

	server.tool(
		'list_extensions_code',
		`Lists installed VS Code extensions with versions, or the workspace's recommended extensions that are not installed yet (.vscode/extensions.json vs reality).

        WHEN TO USE: Reproducing a teammate's setup, checking whether a helper extension is available before relying on its commands, onboarding reviews.`,
		{
			filter: z.string().optional().default('').describe('Only show extensions whose id or description contains this text (case-insensitive)'),
			includeBuiltins: z.boolean().optional().default(false).describe('Include the built-in vscode.* extensions'),
			missingOnly: z.boolean().optional().default(false).describe('List recommended-but-not-installed extensions from .vscode/extensions.json instead of installed ones'),
			workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
		},
		async ({ filter = '', includeBuiltins = false, missingOnly = false, workspace }): Promise<CallToolResult> => {
			const needle = filter.trim().toLowerCase();

			if (missingOnly) {
				const folder = resolveWorkspaceFolder(workspace);
				const recommendations = readWorkspaceRecommendations(folder.uri.fsPath);
				if (recommendations.length === 0) {
					return { content: [{ type: 'text', text: `No recommendations found in ${folder.name}/.vscode/extensions.json.` }] };
				}
				const installed = new Set(vscode.extensions.all.map(ext => ext.id.toLowerCase()));
				const missing = recommendations
					.filter(id => !installed.has(id.toLowerCase()))
					.filter(id => !needle || id.toLowerCase().includes(needle));
				const text = missing.length === 0
					? 'Every recommended extension is installed.'
					: formatExtensionList('Recommended but not installed', missing.map(id => ({ id, version: '-', description: '' })));
				return { content: [{ type: 'text', text }] };
			}

			let extensions = collectInstalledExtensions(includeBuiltins);
			if (needle) {
				extensions = extensions.filter(ext =>
					ext.id.toLowerCase().includes(needle) || ext.description.toLowerCase().includes(needle)
				);
			}
			return { content: [{ type: 'text', text: formatExtensionList('Installed extensions', extensions) }] };
		}
	);
}
