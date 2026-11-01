import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { diffPreviewForEdit } from '../utils/edit-preview';

export interface TextMatch {
        line: number;
        column: number;
        context: string;
}

const MAX_REPORTED_MATCHES = 10;
const CONTEXT_LINES = 2;

export interface NearMiss {
        line: number;
        score: number;
        escaped: boolean;
        context: string;
}

const NEAR_MISS_PROBE_LINES = 3;
const ESCAPE = /\\([\s\S])/g;

function unescapeLoose(text: string): string {
        return text.replace(ESCAPE, '$1');
}

function loose(text: string): string {
        return unescapeLoose(text).replace(/\s+/g, ' ').trim();
}

function commonPrefixLength(a: string, b: string): number {
        const max = Math.min(a.length, b.length);
        let i = 0;
        while (i < max && a[i] === b[i]) { i += 1; }
        return i;
}

export function findNearMiss(content: string, needle: string): NearMiss | null {
        const probes = needle.split('\n').slice(0, NEAR_MISS_PROBE_LINES)
                .map(l => l.trim()).filter(l => l.length > 0);
        if (probes.length === 0) {
                return null;
        }
        const wanted = loose(needle);
        const lines = content.split('\n');
        const window = (i: number): string => lines.slice(Math.max(0, i - 1), i + 2).join('\n');

        if (content.includes(needle)) {
                return null;
        }

        for (let i = 0; i < lines.length; i += 1) {
                const relaxed = loose(lines[i]);
                if (relaxed !== '' && (relaxed === wanted || probes.some(p => loose(p) === relaxed))) {
                        return { line: i + 1, score: probes.length, escaped: true, context: window(i) };
                }
        }

        const floor = Math.max(8, Math.ceil(probes[0].length * 0.4));
        let best: NearMiss | null = null;
        for (let i = 0; i < lines.length; i += 1) {
                const trimmed = lines[i].trim();
                if (trimmed.length === 0) {
                        continue;
                }
                let score = 0;
                for (const p of probes) {
                        score = Math.max(score, commonPrefixLength(p, trimmed));
                }
                if (score >= floor && (best === null || score > best.score)) {
                        best = { line: i + 1, score, escaped: false, context: window(i) };
                }
        }
        return best;
}

export function noMatchMessage(path: string, lineCount: number, content: string, needle: string): string {
        const near = findNearMiss(content, needle);
        if (near) {
                const why = near.escaped
                        ? 'Quote it exactly as printed, with no backslashes added in front of quotes.'
                        : 'Match the text as it stands, character for character.';
                return `No match for old_string in ${path}. The file has ${lineCount} lines.\n\nThe closest line is ${near.line}:\n\n${near.context}\n\n${why}`;
        }
        return `No match for old_string in ${path}. The file has ${lineCount} lines and now reads:\n\n${content.split('\n').slice(0, 20).join('\n')}\n\nRead the file again, then retry with the current text.`;
}

export function findTextMatches(content: string, needle: string): TextMatch[] {
        const out: TextMatch[] = [];
        if (needle.length === 0) {
                return out;
        }
        const lines = content.split('\n');
        let from = 0;
        for (;;) {
                const idx = content.indexOf(needle, from);
                if (idx === -1) { break; }
                const before = content.slice(0, idx);
                const line = before.split('\n').length;
                const column = idx - (before.lastIndexOf('\n') + 1) + 1;
                const start = Math.max(0, line - 1 - CONTEXT_LINES);
                const end = Math.min(lines.length, line + CONTEXT_LINES);
                out.push({ line, column, context: lines.slice(start, end).join('\n') });
                from = idx + needle.length;
        }
        return out;
}

export async function applyTextReplacement(
        document: vscode.TextDocument,
        oldString: string,
        newString: string,
        replaceAll: boolean
): Promise<number> {
        const content = document.getText();
        const edit = new vscode.WorkspaceEdit();
        let changed: number;
        if (replaceAll) {
                const parts = content.split(oldString);
                changed = parts.length - 1;
                edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length)), parts.join(newString));
        } else {
                const idx = content.indexOf(oldString);
                changed = 1;
                edit.replace(
                        document.uri,
                        new vscode.Range(document.positionAt(idx), document.positionAt(idx + oldString.length)),
                        newString
                );
        }
        if (!await vscode.workspace.applyEdit(edit)) {
                throw new Error('VS Code refused the edit');
        }
        if (!await document.save()) {
                throw new Error('The edit was applied but the file could not be saved');
        }
        return changed;
}

export async function createWorkspaceFile(
        workspacePath: string,
        content: string,
        overwrite: boolean = false,
        ignoreIfExists: boolean = false,
        workspace?: string
): Promise<void> {
        const fileUri = resolveInputPath(workspacePath, workspace);
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(fileUri, {
                contents: new TextEncoder().encode(content),
                overwrite,
                ignoreIfExists
        });
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
                throw new Error(`Failed to create file: ${fileUri.fsPath}`);
        }
        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);
}

export function registerEditTools(server: McpServer): void {
        server.tool(
                'edit_file_code',
                `Replaces an exact string in a file. This is the default way to change existing code.

WHEN TO USE: any edit to existing code, because it does not depend on line numbers, which go stale the moment anything else touches the file and silently edit the wrong lines.

WHEN NOT TO USE: new files or whole-file rewrites (create_file_code), or a pure insertion where you know the anchor line but not the surrounding text (replace_lines_code).

- 0 matches: fails and names the closest line, so a wrong quote is visible without re-reading.
- 1 match: applies.
- 2+ matches: does NOT apply, and returns every location with surrounding lines. Add context to old_string to disambiguate. A multi-site edit is a decision, not a guess.

Pass replace_all=true only when you mean every occurrence.`,
                {
                        path: z.string().describe('The file to edit'),
                        old_string: z.string().describe('Exact text to find, including indentation. Must be unique unless replace_all is true.'),
                        new_string: z.string().describe('Replacement text'),
                        replace_all: z.boolean().optional().default(false).describe('Replace every occurrence instead of requiring a unique match'),
                        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
                },
                async ({ path, old_string, new_string, replace_all = false, workspace }): Promise<CallToolResult> => {
                        const fileUri = resolveInputPath(path, workspace);
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const before = document.getText();

                        if (old_string.length === 0) {
                                return {
                                        content: [{ type: 'text', text: 'old_string is empty. Pass the exact text to replace, including its indentation.' }],
                                        isError: true
                                };
                        }

                        const matches = findTextMatches(before, old_string);

                        if (matches.length === 0) {
                                return {
                                        content: [{ type: 'text', text: noMatchMessage(path, document.lineCount, before, old_string) }],
                                        isError: true
                                };
                        }

                        if (matches.length > 1 && !replace_all) {
                                const shown = matches.slice(0, MAX_REPORTED_MATCHES);
                                const body = shown.map(m => `line ${m.line}, column ${m.column}:\n${m.context}`).join('\n\n---\n\n');
                                const more = matches.length > shown.length ? `\n\n…and ${matches.length - shown.length} more.` : '';
                                return {
                                        content: [{ type: 'text', text: `old_string matches ${matches.length} places in ${path}, so nothing was changed:\n\n${body}${more}\n\nExtend old_string with surrounding lines to make it unique, or pass replace_all=true to change every occurrence.` }],
                                        isError: true
                                };
                        }

                        const changed = await applyTextReplacement(document, old_string, new_string, replace_all);
                        const preview = diffPreviewForEdit(path, before, document.getText());
                        return {
                                content: [{ type: 'text', text: `Replaced ${changed} occurrence${changed === 1 ? '' : 's'} in ${path}.\n\n${preview}` }]
                        };
                }
        );

        server.tool(
                'create_file_code',
                `Creates new files or completely rewrites existing files.

WHEN TO USE: New files, large modifications (>10 lines), complete file rewrites.
USE edit_file_code instead for: any change to existing code, since it does not depend on line numbers.

File handling: Use overwrite=true to replace existing files, ignoreIfExists=true to skip if file exists.
Always check with list_files_code first unless you specifically want to overwrite.`,
                {
                        path: z.string().describe('The path to the file to create'),
                        content: z.string().describe('The content to write to the file'),
                        overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if the file exists'),
                        ignoreIfExists: z.boolean().optional().default(false).describe('Whether to ignore if the file exists'),
                        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
                },
                async ({ path, content, overwrite = false, ignoreIfExists = false, workspace }): Promise<CallToolResult> => {
                        await createWorkspaceFile(path, content, overwrite, ignoreIfExists, workspace);
                        return { content: [{ type: 'text', text: `File ${path} created successfully` }] };
                }
        );

        server.tool(
                'replace_lines_code',
                `Replaces or deletes a line range, validated against the current lines. For "find this text, put that text" use edit_file_code.

VALIDATE with originalCode (verbatim) OR firstLine + lastLine (start of each end line, 12+ chars; for long/minified lines). Omit content to delete the lines.`,
                {
                        path: z.string().describe('File to modify'),
                        startLine: z.number().describe('1-based, inclusive'),
                        endLine: z.number().describe('1-based, inclusive'),
                        content: z.string().optional().describe('New lines; omit to delete'),
                        originalCode: z.string().optional().describe('Current lines, verbatim'),
                        firstLine: z.string().optional().describe('Start of line startLine'),
                        lastLine: z.string().optional().describe('Start of line endLine'),
                        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
                },
                async ({ path, startLine, endLine, content, originalCode, firstLine, lastLine, workspace }): Promise<CallToolResult> => {
                        const removed = await replaceWorkspaceFileLines(path, startLine - 1, endLine - 1, content, { originalCode, firstLine, lastLine }, workspace);
                        const count = endLine - startLine + 1;
                        const text = content === undefined
                                ? `Deleted lines ${startLine}-${endLine} (${count} line${count === 1 ? '' : 's'}) in ${path}. Lines below moved up by ${removed}.`
                                : `Replaced lines ${startLine}-${endLine} in ${path}`;
                        return { content: [{ type: 'text', text }] };
                }
        );
}

/** Minimum anchor length, so "}" or "<div>" cannot vouch for a whole range. */
export const MIN_ANCHOR_CHARS = 12;

export interface LineValidation {
        originalCode?: string;
        firstLine?: string;
        lastLine?: string;
}

const preview = (line: string): string => JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}…` : line);

/**
 * Checks one anchor against a real line: the anchor (leading whitespace and
 * trailing "..." ignored) must be a prefix of the line, and long enough to
 * identify it unless it is the whole line.
 */
export function anchorMatches(line: string, anchor: string): boolean {
        const want = anchor.replace(/^\s+/, '').replace(/(\.\.\.|…)\s*$/, '').replace(/\r$/, '');
        const have = line.replace(/^\s+/, '');
        if (want.length === 0) {
                return have.length === 0;
        }
        if (!have.startsWith(want)) {
                return false;
        }
        return want.length >= MIN_ANCHOR_CHARS || want.length === have.length;
}

/** The anchor a caller should send for this line: its start, trimmed, at most 40 characters. */
export function suggestAnchor(line: string): string {
        const t = line.replace(/^\s+/, '');
        return t.length <= 40 ? t : t.slice(0, 40);
}

/** Throws with the real lines when the validation does not hold. */
export function validateLineRange(current: string[], startLine: number, validation: LineValidation): void {
        const { originalCode, firstLine, lastLine } = validation;
        const first = startLine + 1;
        const last = startLine + current.length;
        if (originalCode !== undefined) {
                const given = originalCode.replace(/\r\n/g, '\n').split('\n');
                if (given.join('\n') === current.join('\n')) {
                        return;
                }
                const at = current.findIndex((line, i) => line !== given[i]);
                const idx = at === -1 ? current.length : at;
                throw new Error(`Original code validation failed at line ${first + idx}: expected ${preview(current[idx] ?? '<end of range>')}, got ${preview(given[idx] ?? '<missing>')}. `
                        + `The range ${first}-${last} has ${current.length} line(s); you sent ${given.length}. Nothing was written. `
                        + 'For long lines, pass firstLine + lastLine (the start of each end line) instead of originalCode.');
        }
        // Every failure below shows the real line starts and the exact anchors
        // to send, so a correct range costs one retry, not a re-read.
        const head = current[0];
        const tail = current[current.length - 1];
        const describe = (n: number, line: string): string => line.trim() === '' ? `line ${n} is blank` : `line ${n} starts with ${preview(line)}`;
        const retry = `If that range is right, retry with firstLine=${JSON.stringify(suggestAnchor(head))}, lastLine=${JSON.stringify(suggestAnchor(tail))}.`;
        if (firstLine === undefined || lastLine === undefined) {
                throw new Error(`Validation required: pass originalCode (the lines verbatim) or firstLine + lastLine (the text line ${first} and line ${last} start with). Nothing was written. ${describe(first, head)}; ${describe(last, tail)}. ${retry}`);
        }
        const problems: string[] = [];
        if (!anchorMatches(head, firstLine)) {
                problems.push(describe(first, head));
        }
        if (!anchorMatches(tail, lastLine) && !(current.length === 1 && problems.length)) {
                problems.push(describe(last, tail));
        }
        if (problems.length) {
                throw new Error(`Anchor check failed: ${problems.join('; ')}. Nothing was written. Anchors are the start of the line, at least ${MIN_ANCHOR_CHARS} characters or the whole line. ${retry}`);
        }
}

export async function replaceWorkspaceFileLines(
        workspacePath: string,
        startLine: number,
        endLine: number,
        content: string | undefined,
        validation: string | LineValidation,
        workspace?: string
): Promise<number> {
        const fileUri = resolveInputPath(workspacePath, workspace);
        const document = await vscode.workspace.openTextDocument(fileUri);

        if (startLine < 0 || startLine >= document.lineCount) {
                throw new Error(`Start line ${startLine + 1} is out of range (1-${document.lineCount})`);
        }
        if (endLine < startLine || endLine >= document.lineCount) {
                throw new Error(`End line ${endLine + 1} is out of range (${startLine + 1}-${document.lineCount})`);
        }

        const current: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
                current.push(document.lineAt(i).text);
        }
        validateLineRange(current, startLine, typeof validation === 'string' ? { originalCode: validation } : validation);

        let range: vscode.Range;
        if (content !== undefined) {
                range = new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(endLine, document.lineAt(endLine).text.length)
                );
        } else if (endLine + 1 < document.lineCount) {
                // Delete the lines and the line break after the last one.
                range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine + 1, 0));
        } else if (startLine > 0) {
                // Last lines of the file: take the line break before them instead.
                range = new vscode.Range(
                        new vscode.Position(startLine - 1, document.lineAt(startLine - 1).text.length),
                        new vscode.Position(endLine, document.lineAt(endLine).text.length)
                );
        } else {
                range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(endLine, document.lineAt(endLine).text.length));
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, content ?? '');
        if (!await vscode.workspace.applyEdit(edit)) {
                throw new Error(`Failed to replace lines in file: ${fileUri.fsPath}`);
        }
        await document.save();
        return content === undefined ? endLine - startLine + 1 : 0;
}
