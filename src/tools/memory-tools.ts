import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveWorkspaceFolder, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import {
        BOOTSTRAP_MEMORY_CHARS,
        appendLogEntry,
        clip,
        clipLog,
        projectLogPath,
        projectStatePath,
        readTextFile,
        renderState,
        tailLog,
        writeTextFile
} from '../utils/workspace-state';

const MAMMOUTH_DIR = path.join(os.homedir(), 'Mammouth');
const GLOBAL_MEMORY_FILE = path.join(MAMMOUTH_DIR, 'MEMORY.md');

function getProjectMemoryPath(ref?: string): string | undefined {

        if (listWorkspaceFolders().length === 0) {
                return undefined;
        }
        const folder = resolveWorkspaceFolder(ref);
        const sanitizedName = folder.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(folder.uri.fsPath, `${sanitizedName}_MEMORY.md`);
}

async function ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch (error) {
                if (error instanceof vscode.FileSystemError && error.code === 'FileExists') {
                        return;
                }
                throw error;
        }
}

async function readMemoryFile(filePath: string): Promise<string | null> {
        try {
                const uri = vscode.Uri.file(filePath);
                const content = await vscode.workspace.fs.readFile(uri);
                return Buffer.from(content).toString('utf-8');
        } catch (error) {
                if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                        return null;
                }
                throw error;
        }
}

async function writeMemoryFile(filePath: string, content: string): Promise<void> {
        const dirPath = path.dirname(filePath);
        await ensureDirectoryExists(dirPath);
        const uri = vscode.Uri.file(filePath);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

function getCurrentDate(): string {
        return new Date().toISOString().split('T')[0];
}

function findSectionEnd(content: string, sectionHeader: string, sectionLevel?: number): number {
        const lines = content.split('\n');
        let inSection = false;
        let foundLevel = 0;
        for (let i = 0; i < lines.length; i++) {
                const headerMatch = lines[i].match(/^(#+)\s+(.+)$/);
                if (!headerMatch) {
                        continue;
                }
                const level = headerMatch[1].length;
                const title = headerMatch[2].trim();
                if (!inSection) {

                        if (title === sectionHeader && (sectionLevel === undefined || level === sectionLevel)) {
                                inSection = true;
                                foundLevel = level;
                        }
                } else if (level <= foundLevel) {
                        return i;
                }
        }
        return lines.length;
}

function insertEntryInSection(content: string, sectionHeader: string, entry: string, sectionLevel?: number): string {
        const lines = content.split('\n');
        const sectionEnd = findSectionEnd(content, sectionHeader, sectionLevel);
        const newEntry = `- ${getCurrentDate()}: ${entry}`;
        lines.splice(sectionEnd, 0, newEntry);
        return lines.join('\n');
}

function ensureSectionExists(content: string, sectionHeader: string, sectionLevel = 2): string {
        const lines = content.split('\n');
        const headerPrefix = '#'.repeat(sectionLevel);
        for (const line of lines) {
                const match = line.match(new RegExp(`^${headerPrefix}\\s+(.+)$`));
                if (match && match[1].trim() === sectionHeader) {
                        return content;
                }
        }
        if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
                lines.push('');
        }
        lines.push(`${headerPrefix} ${sectionHeader}`);
        lines.push('');
        return lines.join('\n');
}

function removeEntryFromSection(content: string, sectionHeader: string, entryToRemove?: string): string {
        const lines = content.split('\n');
        let inSection = false;
        let sectionLevel = 0;
        const result: string[] = [];
        for (const line of lines) {
                const headerMatch = line.match(/^(#+)\s+(.+)$/);
                if (headerMatch) {
                        const level = headerMatch[1].length;
                        const title = headerMatch[2].trim();
                        if (!inSection && title === sectionHeader) {
                                inSection = true;
                                sectionLevel = level;
                                if (!entryToRemove) {
                                        continue;
                                }
                                result.push(line);
                                continue;
                        } else if (inSection && level <= sectionLevel) {
                                inSection = false;
                        }
                }
                if (inSection && !entryToRemove) {
                        continue;
                }
                if (inSection && entryToRemove && line.trim().startsWith('- ') && line.includes(entryToRemove)) {
                        continue;
                }
                result.push(line);
        }

        return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

function searchMemoryContent(content: string, query: string): Array<{ section: string; line: string; lineNumber: number }> {
        const results: Array<{ section: string; line: string; lineNumber: number }> = [];
        const lines = content.split('\n');
        let currentSection = 'Root';
        let sectionLevel = 0;
        const lowerQuery = query.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const headerMatch = line.match(/^(#+)\s+(.+)$/);
                if (headerMatch) {
                        currentSection = headerMatch[2].trim();
                        sectionLevel = headerMatch[1].length;
                } else if (line.toLowerCase().includes(lowerQuery)) {
                        results.push({
                                section: currentSection,
                                line: line.trim(),
                                lineNumber: i + 1
                        });
                }
        }
        return results;
}

export async function loadAllMemory(workspace?: string): Promise<{ global: string | null; project: string | null; projectPath: string | undefined }> {
        const globalMemory = await readMemoryFile(GLOBAL_MEMORY_FILE);
        const projectPath = getProjectMemoryPath(workspace);
        const projectMemory = projectPath ? await readMemoryFile(projectPath) : null;
        return { global: globalMemory, project: projectMemory, projectPath };
}

export function registerMemoryTools(server: McpServer): void {
        server.tool('memory_load_code', `Loads the persistent memory system. Reads global memory (~/Mammouth/MEMORY.md), project memory ({workspaceName}_MEMORY.md in workspace root) and the workspace state snapshot.

WHEN TO USE: ONCE per conversation, on the very first user message only — not before every reply. Skip it when memory is already loaded in the current conversation, even if several turns have passed. Prefer session_bootstrap_code, which returns the same context plus layout and skills in one call.

Long files are trimmed to a budget and the tool reports how much was cut. Pass full=true to get everything verbatim.`, {
                full: z.boolean().optional().default(false).describe('Return memory files verbatim instead of trimming them to a budget'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ full = false, workspace }) => {
                const { global, project, projectPath } = await loadAllMemory(workspace);
                const statePath = projectStatePath(workspace);
                const state = statePath ? await readTextFile(statePath) : null;
                const budget = (text: string): string => full ? `${text}\n` : `${clip(text, BOOTSTRAP_MEMORY_CHARS)}\n`;
                let result = '# 🧠 Memory Loaded\n\n';
                if (global) {
                        result += '## 📍 Global Memory (~/Mammouth/MEMORY.md)\n\n';
                        result += budget(global);
                        result += '\n---\n\n';
                } else {
                        result += '## 📍 Global Memory (~/Mammouth/MEMORY.md)\n\n';
                        result += '*No global memory found. Create ~/Mammouth/MEMORY.md to store persistent preferences.*\n\n---\n\n';
                }
                if (state) {
                        result += `## 🧭 Workspace State (${statePath})\n\n${state}\n\n---\n\n`;
                }
                if (project) {
                        result += `## 📁 Project Memory (${projectPath})\n\n`;
                        result += budget(project);
                } else if (projectPath) {
                        result += `## 📁 Project Memory (${projectPath})\n\n`;
                        result += '*No project memory found. Use memory_save_code with scope="project" to create it.*';
                } else {
                        result += '## 📁 Project Memory\n\n';
                        result += '*No workspace open — project memory unavailable.*';
                }
                return { content: [{ type: 'text', text: result }] };
        });

        server.tool('memory_save_code', `Saves an entry to memory. Appends a dated entry under a section header in either global or project memory.

WHEN TO USE: Remember user preferences, project decisions, snippets, or any context that should persist across sessions.

Scope "global" → ~/Mammouth/MEMORY.md (user identity, preferences, workflow)
Scope "project" → {workspaceName}_MEMORY.md in workspace root (project rules, decisions, context)`, {
                section: z.string().describe('Section header (e.g., "Préférences utilisateur", "Contexte projet", "Règles personnelles")'),
                entry: z.string().describe('The fact/rule/preference to remember'),
                scope: z.enum(['global', 'project']).optional().default('project').describe('Which memory to save to: "global" for ~/Mammouth/MEMORY.md, "project" for workspace memory'),
                sectionLevel: z.number().min(1).max(6).optional().default(2).describe('Markdown header level for the section (default: 2 for ##)'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ section, entry, scope = 'project', sectionLevel = 2, workspace }) => {
                const targetPath = scope === 'global' ? GLOBAL_MEMORY_FILE : getProjectMemoryPath(workspace);
                if (!targetPath) {
                        throw new Error('No workspace open — cannot save to project memory. Use scope="global" or open a workspace.');
                }
                let content = await readMemoryFile(targetPath) || '# 🧠 Mémoire\n\n';
                content = ensureSectionExists(content, section, sectionLevel);
                content = insertEntryInSection(content, section, entry, sectionLevel);
                await writeMemoryFile(targetPath, content);
                const location = scope === 'global' ? '~/Mammouth/MEMORY.md' : targetPath;
                return {
                        content: [{
                                type: 'text',
                                text: `✅ Saved to ${scope} memory (${location}) under section "## ${section}":\n- ${getCurrentDate()}: ${entry}`
                        }]
                };
        });

        server.tool('memory_search_code', `Searches memory for a keyword across global and/or project memory.

WHEN TO USE: Find previously saved preferences, decisions, or snippets without reading entire memory files.`, {
                query: z.string().describe('Search term to find in memory entries'),
                scope: z.enum(['global', 'project', 'both']).optional().default('both').describe('Which memory to search: "global", "project", or "both"'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ query, scope = 'both', workspace }) => {
                const { global, project, projectPath } = await loadAllMemory(workspace);
                const results: Array<{ source: string; section: string; line: string; lineNumber: number }> = [];
                if ((scope === 'global' || scope === 'both') && global) {
                        const globalResults = searchMemoryContent(global, query);
                        for (const r of globalResults) {
                                results.push({ source: 'Global (~/Mammouth/MEMORY.md)', ...r });
                        }
                }
                if ((scope === 'project' || scope === 'both') && project) {
                        const projectResults = searchMemoryContent(project, query);
                        for (const r of projectResults) {
                                results.push({ source: `Project (${projectPath})`, ...r });
                        }
                }
                if (results.length === 0) {
                        return { content: [{ type: 'text', text: `No matches found for "${query}" in ${scope} memory.` }] };
                }
                let output = `Found ${results.length} match(es) for "${query}":\n\n`;
                for (const r of results) {
                        output += `📍 **${r.source}** → Section: ${r.section} (line ${r.lineNumber})\n`;
                        output += `   ${r.line}\n\n`;
                }
                return { content: [{ type: 'text', text: output }] };
        });

        server.tool('memory_clear_code', `Removes an entry or entire section from memory. Use to correct outdated or wrong information.

WHEN TO USE: Memory becomes toxic if it accumulates stale/incorrect data. Clean it up periodically.

Provide entry to remove a specific bullet. Omit entry to remove the entire section.`, {
                section: z.string().describe('Section header to clear from'),
                entry: z.string().optional().describe('Specific entry text to remove (omit to delete entire section)'),
                scope: z.enum(['global', 'project']).optional().default('project').describe('Which memory to clear from'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ section, entry, scope = 'project', workspace }) => {
                const targetPath = scope === 'global' ? GLOBAL_MEMORY_FILE : getProjectMemoryPath(workspace);
                if (!targetPath) {
                        throw new Error('No workspace open — cannot clear project memory. Use scope="global" or open a workspace.');
                }
                const content = await readMemoryFile(targetPath);
                if (!content) {
                        return { content: [{ type: 'text', text: `No ${scope} memory file found at ${targetPath}` }] };
                }
                const newContent = entry
                        ? removeEntryFromSection(content, section, entry)
                        : removeEntryFromSection(content, section);
                await writeMemoryFile(targetPath, newContent);
                const location = scope === 'global' ? '~/Mammouth/MEMORY.md' : targetPath;
                const action = entry ? `Removed entry` : `Cleared entire section`;
                return {
                        content: [{
                                type: 'text',
                                text: `✅ ${action} "${section}"${entry ? `: "${entry}"` : ''} from ${scope} memory (${location})`
                        }]
                };
        });

        server.tool('workspace_state_code', `Reads or overwrites the CURRENT working state of this workspace: version, branch, status, what is in progress, and the next step.

WHEN TO USE: at the start of a task to find out where the last session stopped, and at the end to record where you stopped. The state file is a small snapshot that gets overwritten, so it never grows — unlike memory, which only accumulates.

Actions:
- read (default): the current state snapshot.
- write {version, branch, status, inProgress, nextStep}: overwrites the snapshot. Omit any field to clear it.

The next session reads this through session_bootstrap_code, so write a real next step — that is the whole point.`, {
                action: z.enum(['read', 'write']).optional().default('read').describe('Read the state snapshot or overwrite it'),
                version: z.string().optional().describe('write: version or build identifier currently being worked on'),
                branch: z.string().optional().describe('write: current git branch or tag'),
                status: z.string().optional().describe('write: short overall status, e.g. "tests green", "2 files failing"'),
                inProgress: z.string().optional().describe('write: what is currently being worked on'),
                nextStep: z.string().optional().describe('write: the single next action to take on resuming'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ action = 'read', version, branch, status, inProgress, nextStep, workspace }) => {
                const target = projectStatePath(workspace);
                if (!target) {
                        throw new Error('No workspace open — workspace state needs an open folder.');
                }
                if (action === 'write') {
                        const content = renderState({ version, branch, status, inProgress, nextStep });
                        await writeTextFile(target, content);
                        return { content: [{ type: 'text', text: `✅ Workspace state written to ${target}:\n\n${content}` }] };
                }
                const existing = await readTextFile(target);
                if (!existing) {
                        return { content: [{ type: 'text', text: `No workspace state yet at ${target}. Use workspace_state_code(action="write", …) to record where the work stands.` }] };
                }
                return { content: [{ type: 'text', text: `# Workspace state (${target})\n\n${existing}` }] };
        });

        server.tool('session_end_code', `Closes out a work session: records what was done, what is still open, and the next step, so the next conversation resumes instead of starting over.

WHEN TO USE: as the LAST tool call of a task, right before you report completion. Not for every reply — only when a unit of work is finished, handed off, or abandoned.

It does two things:
- writes the workspace state snapshot (version, branch, in progress, next step) that session_bootstrap_code loads next time;
- appends a dated session summary to the workspace log.

The summary is the part a tool cannot infer: the intent behind the work, the decisions you made and why, and anything you deliberately left out. Write it for someone with no memory of this conversation.`, {
                summary: z.string().describe('What was done, what was decided and why, what was deliberately skipped. Concrete, not generic.'),
                version: z.string().optional().describe('Version or build identifier this session was working on'),
                branch: z.string().optional().describe('Current git branch or tag'),
                status: z.string().optional().describe('Short overall status at close, e.g. "builds clean, 1 test skipped"'),
                inProgress: z.string().optional().describe('Anything still unfinished at close'),
                nextStep: z.string().optional().describe('The single next action for whoever resumes this'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ summary, version, branch, status, inProgress, nextStep, workspace }) => {
                const stateTarget = projectStatePath(workspace);
                const logTarget = projectLogPath(workspace);
                if (!stateTarget || !logTarget) {
                        throw new Error('No workspace open — session_end_code needs an open folder.');
                }
                const state = renderState({ version, branch, status, inProgress, nextStep });
                await writeTextFile(stateTarget, state);
                const existingLog = await readTextFile(logTarget);
                const appended = appendLogEntry(existingLog ?? '', {
                        ts: new Date().toISOString(),
                        session: `summary-${Date.now().toString(36)}`,
                        tool: 'session_end_code',
                        detail: summary.replace(/\s+/g, ' ').trim(),
                        ok: true
                });
                await writeTextFile(logTarget, clipLog(appended));
                return {
                        content: [{
                                type: 'text',
                                text: `✅ Session closed.\n\nState → ${stateTarget}\nLog → ${logTarget}\n\n${state}\n\nLogged summary: ${summary.slice(0, 400)}${summary.length > 400 ? '…' : ''}`
                        }]
                };
        });

        server.tool('workspace_log_code', `Reads the workspace session log: a dated, budgeted history of what happened, most recent last. Rotates automatically so it never grows without bound.

WHEN TO USE: to recover detail that workspace_state_code does not carry — the last few sessions, how a problem was approached before, or why a file looks the way it does. For a keyword lookup prefer memory_search_code.`, {
                count: z.number().int().min(1).max(20).optional().default(5).describe('How many recent entries to return (default 5)'),
                workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        }, async ({ count = 5, workspace }) => {
                const target = projectLogPath(workspace);
                if (!target) {
                        throw new Error('No workspace open — workspace log needs an open folder.');
                }
                const existing = await readTextFile(target);
                if (!existing) {
                        return { content: [{ type: 'text', text: `No workspace log yet at ${target}. It is written by session_end_code and by tool activity.` }] };
                }
                const { text } = tailLog(existing, count);
                return { content: [{ type: 'text', text: `# Workspace log (${target})\n\n${text}` }] };
        });
}
