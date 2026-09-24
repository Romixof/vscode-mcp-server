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

WHEN TO USE: any edit to existing code, because it does not depend on line numbers. Line numbers go stale the moment anything else touches the file, and a stale line number silently edits the wrong lines.

WHEN NOT TO USE: new files or whole-file rewrites (create_file_code), or a pure insertion where you know the anchor line but not the surrounding text (replace_lines_code).

- 0 matches: fails and says the text was not found. Re-read the file, it moved.
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
                                const preview = before.split('\n').slice(0, 20).join('\n');
                                return {
                                        content: [{ type: 'text', text: `No match for old_string in ${path}. The file has ${document.lineCount} lines and now reads:\n\n${preview}\n\nRead the file again, then retry with the current text.` }],
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
                `Replaces a line range in an existing file, validated against the current content.

WHEN TO USE: a pure insertion or deletion at a known line, or an edit larger than a single exact string.
USE edit_file_code instead for: any change to existing code you can describe as "find this text, put that text there". It survives other edits shifting line numbers, which this tool does not.

CRITICAL: originalCode must match the current file content exactly or the tool fails.
If it fails: read_file_code on the target lines, then retry.`,
                {
                        path: z.string().describe('The path to the file to modify'),
                        startLine: z.number().describe('The start line number (1-based, inclusive)'),
                        endLine: z.number().describe('The end line number (1-based, inclusive)'),
                        content: z.string().describe('The new content to replace the lines with'),
                        originalCode: z.string().describe('The original code for validation - must match exactly'),
                        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
                },
                async ({ path, startLine, endLine, content, originalCode, workspace }): Promise<CallToolResult> => {
                        await replaceWorkspaceFileLines(path, startLine - 1, endLine - 1, content, originalCode, workspace);
                        return { content: [{ type: 'text', text: `Replaced lines ${startLine}-${endLine} in ${path}` }] };
                }
        );
}

export async function replaceWorkspaceFileLines(
        workspacePath: string,
        startLine: number,
        endLine: number,
        content: string,
        originalCode: string,
        workspace?: string
): Promise<void> {
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
        if (current.join('\n') !== originalCode) {
                throw new Error('Original code validation failed. The current content does not match the provided original code.');
        }

        const range = new vscode.Range(
                new vscode.Position(startLine, 0),
                new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, content);
        if (!await vscode.workspace.applyEdit(edit)) {
                throw new Error(`Failed to replace lines in file: ${fileUri.fsPath}`);
        }
        await document.save();
}
