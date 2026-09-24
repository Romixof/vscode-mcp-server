import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listWorkspaceFolders } from '../utils/workspace';

const MAX_TABS = 50;
const MAX_SELECTION_CHARS = 4000;

function lineText(document: vscode.TextDocument, line: number): string {
        if (line < 0 || line >= document.lineCount) {
                return '';
        }
        return document.lineAt(line).text;
}

export function registerEditorTools(server: McpServer): void {
        server.tool(
                'get_active_editor_code',
                `Reads the editor the user is currently looking at: file, cursor, selection, and visible range.

WHEN TO USE: the user says "this", "here", "fix that", "why is this broken" without naming a file. Without this you cannot know which file they mean, and guessing wastes a read_file_code call on the wrong path.

Also the only way to get a selection, which is how a user highlights the exact lines they want changed.`,
                {},
                async (): Promise<CallToolResult> => {
                        const editor = vscode.window.activeTextEditor;
                        if (!editor) {
                                const open = vscode.window.visibleTextEditors.length;
                                return {
                                        content: [{ type: 'text', text: open > 0 ? `${open} editor(s) are visible but none is focused. Ask the user to click into the file they mean.` : 'No editor is open. Ask the user which file they mean.' }],
                                        isError: true
                                };
                        }
                        const doc = editor.document;
                        const sel = editor.selection;
                        const selected = doc.getText(sel);
                        const visible = editor.visibleRanges[0];
                        const lines: string[] = [];
                        lines.push(`file:      ${doc.uri.fsPath}`);
                        lines.push(`language:  ${doc.languageId}`);
                        lines.push(`size:      ${doc.lineCount} lines`);
                        lines.push(`dirty:     ${doc.isDirty ? 'yes, unsaved changes' : 'no'}`);
                        lines.push(`cursor:    line ${sel.active.line + 1}, column ${sel.active.character + 1}`);
                        if (visible) {
                                lines.push(`visible:   lines ${visible.start.line + 1}-${visible.end.line + 1}`);
                        }
                        lines.push('');
                        lines.push('--- cursor line ---');
                        lines.push(`${sel.active.line + 1}: ${lineText(doc, sel.active.line)}`);
                        if (!sel.isEmpty) {
                                const start = sel.start.line + 1;
                                const end = sel.end.line + 1;
                                lines.push('');
                                lines.push(`--- selection (lines ${start}-${end}) ---`);
                                lines.push(selected.length > MAX_SELECTION_CHARS ? `${selected.slice(0, MAX_SELECTION_CHARS)}\n[… ${selected.length - MAX_SELECTION_CHARS} more chars]` : selected);
                        }
                        return { content: [{ type: 'text', text: lines.join('\n') }] };
                }
        );

        server.tool(
                'list_open_tabs_code',
                `Lists the editors open in this window, with the active one marked.

WHEN TO USE: the user refers to a file by role rather than name ("the test file", "the component I was editing") and get_active_editor_code is not enough. Also a quick way to see what else is in front of them.

Paths come back relative to their workspace folder when one owns the file, so they can be passed straight to a path tool.`,
                {},
                async (): Promise<CallToolResult> => {
                        const editors = vscode.window.visibleTextEditors;
                        if (editors.length === 0) {
                                return { content: [{ type: 'text', text: 'No editors are open.' }] };
                        }
                        const active = vscode.window.activeTextEditor;
                        const folders = listWorkspaceFolders();
                        const shown = editors.slice(0, MAX_TABS);
                        const lines = shown.map(editor => {
                                const isActive = active !== undefined && editor.document === active.document;
                                const folder = folders.find(f => editor.document.uri.fsPath.startsWith(f.uri.fsPath));
                                const shown_path = folder
                                        ? `${folder.name}/${editor.document.uri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/')}`
                                        : editor.document.uri.fsPath;
                                return `${isActive ? '*' : ' '} ${shown_path}  (${editor.document.lineCount} lines${editor.document.isDirty ? ', unsaved' : ''})`;
                        });
                        const more = editors.length > shown.length ? `\n…and ${editors.length - shown.length} more.` : '';
                        const header = `Open editors (${editors.length}), * marks the active one:\n\n`;
                        return { content: [{ type: 'text', text: header + lines.join('\n') + more }] };
                }
        );
}
