import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { resolveWorkspaceFolder, listWorkspaceFolders } from './workspace';

export const STATE_MAX_CHARS = 2000;
export const LOG_MAX_CHARS = 20000;
export const LOG_KEEP_ENTRIES = 40;
export const BOOTSTRAP_LOG_ENTRIES = 4;
export const BOOTSTRAP_MEMORY_CHARS = 3000;

function sanitizeName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function projectStatePath(ref?: string): string | undefined {
        if (listWorkspaceFolders().length === 0) {
                return undefined;
        }
        const folder = resolveWorkspaceFolder(ref);
        return path.join(folder.uri.fsPath, `${sanitizeName(folder.name)}_STATE.md`);
}

export function projectLogPath(ref?: string): string | undefined {
        if (listWorkspaceFolders().length === 0) {
                return undefined;
        }
        const folder = resolveWorkspaceFolder(ref);
        return path.join(folder.uri.fsPath, `${sanitizeName(folder.name)}_LOG.md`);
}

async function ensureDir(dirPath: string): Promise<void> {
        try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch (error) {
                if (error instanceof vscode.FileSystemError && error.code === 'FileExists') {
                        return;
                }
                throw error;
        }
}

export async function readTextFile(filePath: string): Promise<string | null> {
        try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                return Buffer.from(content).toString('utf-8');
        } catch (error) {
                if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                        return null;
                }
                throw error;
        }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
        await ensureDir(path.dirname(filePath));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));
}

export function clip(text: string, max: number): string {
        if (text.length <= max) {
                return text;
        }
        return `${text.slice(0, max)}\n[… ${text.length - max} chars trimmed]`;
}

export interface StateFields {
        version?: string;
        branch?: string;
        status?: string;
        inProgress?: string;
        nextStep?: string;
        updatedAt?: string;
}

export function renderState(fields: StateFields): string {
        const rows: string[] = ['# Workspace state', ''];
        const push = (label: string, value: string | undefined): void => {
                const trimmed = (value ?? '').trim();
                if (trimmed) {
                        rows.push(`- ${label}: ${trimmed}`);
                }
        };
        push('Version', fields.version);
        push('Branch', fields.branch);
        push('Status', fields.status);
        push('In progress', fields.inProgress);
        push('Next step', fields.nextStep);
        push('Updated', fields.updatedAt ?? new Date().toISOString());
        return clip(rows.join('\n') + '\n', STATE_MAX_CHARS);
}

export function parseState(content: string | null): StateFields {
        if (!content) {
                return {};
        }
        const fields: StateFields = {};
        for (const line of content.split('\n')) {
                const match = line.match(/^-\s*([^:]+):\s*(.*)$/);
                if (!match) {
                        continue;
                }
                const key = (match[1] ?? '').trim().toLowerCase();
                const value = (match[2] ?? '').trim();
                if (key === 'version') { fields.version = value; }
                else if (key === 'branch') { fields.branch = value; }
                else if (key === 'status') { fields.status = value; }
                else if (key === 'in progress') { fields.inProgress = value; }
                else if (key === 'next step') { fields.nextStep = value; }
                else if (key === 'updated') { fields.updatedAt = value; }
        }
        return fields;
}

export interface LogEntry {
        ts: string;
        session: string;
        tool: string;
        detail: string;
        ok: boolean;
}

export function formatLogEntry(entry: LogEntry): string {
        return `- \`${entry.ts}\` **${entry.tool}**${entry.ok ? '' : ' (failed)'} — ${entry.detail}`;
}

export function appendLogEntry(content: string, entry: LogEntry): string {
        const base = content && content.trim() ? content.replace(/\n+$/, '') + '\n' : '# Session log\n\n';
        return base + formatLogEntry(entry) + '\n';
}

export function rotateLog(content: string): string {
        const lines = content.split('\n');
        const header = lines[0] ?? '# Session log';
        const entries = lines.filter(l => l.startsWith('- '));
        const kept = entries.slice(-LOG_KEEP_ENTRIES);
        const dropped = entries.length - kept.length;
        const note = dropped > 0 ? `\n\n[${dropped} older entries dropped — budget ${LOG_MAX_CHARS} reached]\n` : '\n';
        return `${header}\n\n${kept.join('\n')}${note}`;
}

export function clipLog(content: string): string {
        const entryCount = content.split('\n').filter(l => l.startsWith('- ')).length;
        if (content.length <= LOG_MAX_CHARS && entryCount <= LOG_KEEP_ENTRIES) {
                return content;
        }
        return rotateLog(content);
}

export function tailLog(content: string, count: number): { text: string; remaining: number } {
        const lines = content.split('\n');
        const entries = lines.filter(l => l.startsWith('- '));
        const kept = entries.slice(-count);
        const remaining = entries.length - kept.length;
        const header = remaining > 0
                ? `[… ${remaining} earlier entries — memory_search_code or the full log file for the rest]\n`
                : '';
        return { text: header + kept.join('\n'), remaining };
}

export function globalMemoryPath(): string {
        return path.join(os.homedir(), 'Mammouth', 'MEMORY.md');
}

const JOURNAL_FLUSH_MS = 4000;
const JOURNAL_DETAIL_KEYS = ['path', 'command', 'query', 'filePath', 'sourcePath', 'section', 'summary', 'name', 'url', 'pattern'];
const JOURNAL_DETAIL_MAX = 160;

let journalBuffer: LogEntry[] = [];
let journalTimer: ReturnType<typeof setTimeout> | undefined;
let journalTarget: string | undefined;

function extractDetail(args: unknown): string {
        if (typeof args !== 'object' || args === null) {
                return '';
        }
        const record = args as Record<string, unknown>;
        for (const key of JOURNAL_DETAIL_KEYS) {
                const value = record[key];
                if (typeof value === 'string' && value.trim()) {
                        const flat = value.replace(/\s+/g, ' ').trim();
                        return flat.length > JOURNAL_DETAIL_MAX ? `${flat.slice(0, JOURNAL_DETAIL_MAX)}…` : flat;
                }
        }
        return '';
}

async function flushJournal(): Promise<void> {
        journalTimer = undefined;
        const pending = journalBuffer;
        const target = journalTarget;
        journalBuffer = [];
        journalTarget = undefined;
        if (pending.length === 0 || !target) {
                return;
        }
        try {
                const existing = await readTextFile(target);
                let content = existing ?? '';
                for (const entry of pending) {
                        content = appendLogEntry(content, entry);
                }
                await writeTextFile(target, clipLog(content));
        } catch {
        }
}

export function recordJournalEvent(tool: string, args: unknown, ok: boolean): void {
        try {
                if (tool === 'session_end_code' || tool === 'workspace_state_code' || tool === 'workspace_log_code') {
                        return;
                }
                const detail = extractDetail(args);
                if (!detail) {
                        return;
                }
                const statePath = projectStatePath();
                if (!statePath) {
                        return;
                }
                const target = statePath.replace(/_STATE\.md$/, '_LOG.md');
                if (journalTarget && journalTarget !== target) {
                        void flushJournal();
                }
                journalTarget = target;
                journalBuffer.push({
                        ts: new Date().toISOString(),
                        session: 'auto',
                        tool,
                        detail,
                        ok
                });
                if (!journalTimer) {
                        journalTimer = setTimeout(() => { void flushJournal(); }, JOURNAL_FLUSH_MS);
                }
        } catch {
        }
}

export function flushJournalNow(): void {
        if (journalTimer) {
                clearTimeout(journalTimer);
                journalTimer = undefined;
        }
        void flushJournal();
}
