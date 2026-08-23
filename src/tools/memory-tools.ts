import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveWorkspaceFolder, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

const MAMMOUTH_DIR = path.join(os.homedir(), 'Mammouth');
const GLOBAL_MEMORY_FILE = path.join(MAMMOUTH_DIR, 'MEMORY.md');

function getProjectMemoryPath(ref?: string): string | undefined {
	// undefined (rather than a thrown error) means no folder is open and lets each
	// tool print its own guidance; a bad ref still fails loudly with "Unknown workspace"
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
			// anchor only on a header at the expected level so ### Détails never captures ## Détails writes
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
	// collapse blank runs left behind by a removal
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

async function loadAllMemory(workspace?: string): Promise<{ global: string | null; project: string | null; projectPath: string | undefined }> {
	const globalMemory = await readMemoryFile(GLOBAL_MEMORY_FILE);
	const projectPath = getProjectMemoryPath(workspace);
	const projectMemory = projectPath ? await readMemoryFile(projectPath) : null;
	return { global: globalMemory, project: projectMemory, projectPath };
}

export function registerMemoryTools(server: McpServer): void {
	server.tool('memory_load_code', `Loads the persistent memory system. Reads global memory (~/Mammouth/MEMORY.md) and project memory ({workspaceName}_MEMORY.md in workspace root).

WHEN TO USE: ONCE per conversation, on the very first user message only — not before every reply. Skip it when memory is already loaded in the current conversation, even if several turns have passed. Loads user identity, preferences, workflow rules, and project-specific context.

Returns merged content with clear separation between global and project memory.`, {
		workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
	}, async ({ workspace }) => {
		const { global, project, projectPath } = await loadAllMemory(workspace);
		let result = '# 🧠 Memory Loaded\n\n';
		if (global) {
			result += '## 📍 Global Memory (~/Mammouth/MEMORY.md)\n\n';
			result += global;
			result += '\n\n---\n\n';
		} else {
			result += '## 📍 Global Memory (~/Mammouth/MEMORY.md)\n\n';
			result += '*No global memory found. Create ~/Mammouth/MEMORY.md to store persistent preferences.*\n\n---\n\n';
		}
		if (project) {
			result += `## 📁 Project Memory (${projectPath})\n\n`;
			result += project;
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
}
