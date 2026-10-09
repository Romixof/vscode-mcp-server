import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceFolder, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { getUsageSnapshot, getTotalCalls, getServerStartTime, getNeverCalledTools, getNeverCalledCount } from '../utils/usage';
import { probePdfBinaries, BinaryStatus } from '../utils/binaries';
import { detectRuntimeFacts, runtimeSection } from '../utils/runtime-facts';
import { loadAllMemory } from './memory-tools';
import { collectSkillsList } from './skills-tools';
import { resolveAgentInstructions, AGENT_INSTRUCTIONS_VERSION } from '../utils/agent-instructions';
import {
        BOOTSTRAP_LOG_ENTRIES,
        BOOTSTRAP_MEMORY_CHARS,
        clip,
        projectLogPath,
        projectStatePath,
        readTextFile,
        tailLog
} from '../utils/workspace-state';

export const EXTENSION_ID = 'Romixo.vscode-mcp-server';

interface ExtensionSummary {
        id: string;
        version: string;
        description: string;
}

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

function readWorkspaceRecommendations(root: string): string[] {
        try {
                const file = path.join(root, '.vscode', 'extensions.json');
                const raw = fs.readFileSync(file, 'utf-8');

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

const NEVER_CALLED_SHOWN = 20;

function binariesSection(statuses: BinaryStatus[]): string[] {
        const lines = ['Binaries:'];
        for (const status of statuses) {
                lines.push(`  - ${status.name}: ${status.found ? `found (${status.path})` : `missing — install ${status.hint}`}`);
        }
        const missing = statuses.filter(s => !s.found).map(s => s.name);                if (missing.length > 0) {
                        const object = missing.length === 1 ? 'it' : 'them';
                        const subject = missing.length === 1 ? 'it' : 'they';
                        const be = missing.length === 1 ? 'is' : 'are';
                        lines.push(`  ${missing.join(', ')} unavailable — the tools that need ${object} will refuse with the same hint until ${subject} ${be} installed.`);
                }
        return lines;
}

function formatExtensionList(title: string, extensions: ExtensionSummary[]): string {
        if (extensions.length === 0) {
                return `${title}: none.`;
        }
        const lines = extensions.map(ext => `- ${ext.id} @ ${ext.version}${ext.description ? ` — ${ext.description}` : ''}`);
        return `${title} (${extensions.length}):\n${lines.join('\n')}`;
}

export function registerAdvancedTools(server: McpServer, endpoint: { host: string; port: number }, clusterInfo?: () => string | undefined, authInfo?: () => string, shellInfo?: () => string | undefined): void {
        server.tool(
                'get_server_info_code',
                `Reports this MCP server's own status: extension/VS Code/Node versions, platform, remote environment (devcontainer / WSL / SSH), open workspace folders, uptime, and how many times each tool has been called across sessions.

        WHEN TO USE: Debugging connectivity ("is it running? where?"), checking which remote the client must reach, reviewing what an agent session has been doing.

        All counters are local to your machine; nothing is sent anywhere.`,
                {},
                async (): Promise<CallToolResult> => {
                        const folders = listWorkspaceFolders();
                        const usage = getUsageSnapshot().slice(0, 20);
                        const uptimeSeconds = Math.round((Date.now() - getServerStartTime()) / 1000);
                        const remoteName = (vscode.env as { remoteName?: string | undefined }).remoteName;
                        const binaries = await probePdfBinaries();

                        const lines = [
                                'Server status',
                                `- Endpoint: http://${endpoint.host}:${endpoint.port}/mcp`,
                                `- Extension version: ${vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version ?? 'unknown'}`,
                                `- VS Code version: ${vscode.version}`,
                                `- Node version: ${process.version}`,
                                `- Platform: ${process.platform}`,
                                `- Shell: ${shellInfo ? shellInfo() : 'unknown'}`,
                                runtimeSection(await detectRuntimeFacts()),
                                ...binariesSection(binaries),
                                `- Environment: ${remoteName ? `remote "${remoteName}" — clients on another machine need port forwarding or a connection inside this remote` : 'local'}`,
                                ...(authInfo ? [`- Auth: ${authInfo()}`] : []),
                                `- Open workspace folders (${folders.length}): ${folders.length ? folders.map((f, i) => `${i + 1}=${f.name}`).join(', ') : 'none'}`,
                                `- Uptime: ${uptimeSeconds}s`,
                                `- Tool calls across sessions: ${getTotalCalls()}`
                        ];
                        if (usage.length > 0) {
                                lines.push('- Top tools: ' + usage.map(u => `${u.tool} (${u.calls})`).join(', '));
                        }
                        const neverTotal = getNeverCalledCount();
                        if (neverTotal > 0) {
                                const shown = getNeverCalledTools(NEVER_CALLED_SHOWN).join(', ');
                                const more = neverTotal > NEVER_CALLED_SHOWN ? `, and ${neverTotal - NEVER_CALLED_SHOWN} more` : '';
                                lines.push(`- Registered but never called across sessions (${neverTotal}): ${shown}${more}`);
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


export function registerSessionBootstrapTool(server: McpServer, guideOverride?: () => string | undefined): void {
        let deliveredGuide = '';
        server.tool(
                'session_bootstrap_code',
                `ONE-CALL session start: persistent memory (global + project), workspace folders + root layout, skills list, and the full agent guide in one response.

        WHEN TO USE: ONCE at the very start of every conversation — replaces four separate opening calls. Clients cap tool calls per response: spend them on the task, not on loading context.

        Refresh only known sections with sections=[...] (e.g. ["memory","layout"]); omit it for all four.

        COMPACT: mode="compact" returns ONLY the state snapshot plus a pointer to the full call (~800 tokens) — for re-anchoring mid-conversation after a model switch or context trim.`, {
                        sections: z.array(z.enum(['memory', 'guide', 'skills', 'layout'])).optional().describe('Parts to return; omit for all four. "layout" is 1 level deep, 40 entries max.'),
                        mode: z.enum(['full', 'compact']).optional().default('full').describe('compact = state snapshot + pointer only, for re-anchoring mid-conversation'),
                        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
                },
                async ({ sections, mode = 'full', workspace }): Promise<CallToolResult> => {
                        const want = (name: 'memory' | 'guide' | 'skills' | 'layout'): boolean => !sections || sections.includes(name);
                        const memory = want('memory');
                        const guide = want('guide');
                        const skills = want('skills');
                        const layout = want('layout');
                        const parts: string[] = ['# 🚀 Session bootstrap'];
                        if (mode === 'compact') {
                                const statePath = projectStatePath(workspace);
                                const state = statePath ? await readTextFile(statePath) : null;
                                parts.push('\n## 🧭 Workspace state (compact re-anchor)\n');
                                // A file that exists but is blank (whitespace-only) reads as '' —
                                // not null — so a plain ?? would serve an empty section. Treat
                                // any blank read the same as a missing file.
                                parts.push(state && state.trim() ? state : '*No workspace state recorded yet — call the full session_bootstrap_code() or workspace_state_code(action="write", …) to create one.*');
                                parts.push(`\n\nFull re-anchor (memory + layout + skills + guide): call session_bootstrap_code() with no arguments.`);
                                return { content: [{ type: 'text', text: parts.join('\n') }] };
                        }
                        if (memory) {
                                const { global, project, projectPath } = await loadAllMemory(workspace);
                                const statePath = projectStatePath(workspace);
                                const state = statePath ? await readTextFile(statePath) : null;
                                const logPath = projectLogPath(workspace);
                                const log = logPath ? await readTextFile(logPath) : null;
                                const budgeted = (text: string | null): string => text === null ? '' : clip(text, BOOTSTRAP_MEMORY_CHARS);
                                if (state) {
                                        parts.push(`\n## 🧭 Workspace state (${statePath})\n`);
                                        parts.push(state);
                                }
                                parts.push('\n## 📍 Memory (~/Mammouth/MEMORY.md)\n');
                                parts.push(budgeted(global) || '*No global memory found.*');
                                if (project) {
                                        parts.push(`\n\n## 📁 Project Memory (${projectPath})\n\n${budgeted(project)}`);
                                } else if (projectPath) {
                                        parts.push('\n\n## 📁 Project Memory\n\n*No project memory found. Use memory_save_code with scope="project" to create it.*');
                                }
                                if (log) {
                                        const { text: recent } = tailLog(log, BOOTSTRAP_LOG_ENTRIES);
                                        if (recent.trim()) {
                                                parts.push(`\n\n## 📓 Recent activity (${logPath})\n`);
                                                parts.push(recent);
                                        }
                                }
                        }
                        if (layout) {
                                const folders = listWorkspaceFolders();
                                parts.push('\n\n## Workspace');
                                if (folders.length === 0) {
                                        parts.push('\n*No folder open.*');
                                } else {
                                        folders.forEach((f, i) => parts.push(`${i + 1}. ${f.name} -> ${f.uri.fsPath}`));
                                        const first = folders[0];
                                        try {
                                                const entries = await vscode.workspace.fs.readDirectory(first.uri);
                                                entries.sort((a, b) => (((b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory)) || a[0].localeCompare(b[0])));
                                                const shown = entries.slice(0, 40);
                                                parts.push(`\nRoot of "${first.name}" (${entries.length} entries${entries.length > shown.length ? ', first 40 shown' : ''}):`);
                                                parts.push(shown.map(([name, type]) => `- ${name}${(type & vscode.FileType.Directory) ? '/' : ''}`).join('\n'));
                                        } catch {
                                                parts.push('\n(root listing unavailable)');
                                        }
                                }
                        }
                        if (skills) {
                                parts.push('\n\n## Skills\n');
                                parts.push(await collectSkillsList(undefined, workspace));
                        }
                        if (guide) {
                                const override = guideOverride ? guideOverride() : undefined;
                                const text = resolveAgentInstructions(override);
                                if (text === deliveredGuide) {
                                        parts.push(`\n\n## Agent guide\n\nv${AGENT_INSTRUCTIONS_VERSION} was already sent in this VS Code session. If you do not have it in context, call get_agent_instructions_code() once.`);
                                } else {
                                        parts.push(`\n\n## Agent guide\n\n${text}\n\n[agent guide v${AGENT_INSTRUCTIONS_VERSION}]`);
                                        deliveredGuide = text;
                                }
                        }
                        return { content: [{ type: 'text', text: parts.join('\n') }] };
                }
        );
}
