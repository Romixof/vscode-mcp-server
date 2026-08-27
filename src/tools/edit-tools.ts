import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

export async function createWorkspaceFile(
    workspacePath: string,
    content: string,
    overwrite: boolean = false,
    ignoreIfExists: boolean = false,
    workspace?: string
): Promise<void> {
    console.log(`[createWorkspaceFile] Starting with path: ${workspacePath}, overwrite: ${overwrite}, ignoreIfExists: ${ignoreIfExists}`);

    const fileUri = resolveInputPath(workspacePath, workspace);
    console.log(`[createWorkspaceFile] File URI: ${fileUri.fsPath}`);

    try {

        const workspaceEdit = new vscode.WorkspaceEdit();

        const contentBuffer = new TextEncoder().encode(content);

        workspaceEdit.createFile(fileUri, {
            contents: contentBuffer,
            overwrite: overwrite,
            ignoreIfExists: ignoreIfExists
        });

        const success = await vscode.workspace.applyEdit(workspaceEdit);

        if (success) {
            console.log(`[createWorkspaceFile] File created successfully: ${fileUri.fsPath}`);

            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            console.log(`[createWorkspaceFile] File opened in editor`);
        } else {
            throw new Error(`Failed to create file: ${fileUri.fsPath}`);
        }
    } catch (error) {
        console.error('[createWorkspaceFile] Error:', error);
        throw error;
    }
}

export async function replaceWorkspaceFileLines(
    workspacePath: string,
    startLine: number,
    endLine: number,
    content: string,
    originalCode: string,
    workspace?: string
): Promise<void> {
    console.log(`[replaceWorkspaceFileLines] Starting with path: ${workspacePath}, lines: ${startLine}-${endLine}`);

    const fileUri = resolveInputPath(workspacePath, workspace);
    console.log(`[replaceWorkspaceFileLines] File URI: ${fileUri.fsPath}`);

    try {

        const document = await vscode.workspace.openTextDocument(fileUri);

        if (startLine < 0 || startLine >= document.lineCount) {
            throw new Error(`Start line ${startLine + 1} is out of range (1-${document.lineCount})`);
        }
        if (endLine < startLine || endLine >= document.lineCount) {
            throw new Error(`End line ${endLine + 1} is out of range (${startLine + 1}-${document.lineCount})`);
        }

        const currentLines = [];
        for (let i = startLine; i <= endLine; i++) {
            currentLines.push(document.lineAt(i).text);
        }
        const currentContent = currentLines.join('\n');

        if (currentContent !== originalCode) {
            throw new Error(`Original code validation failed. The current content does not match the provided original code.`);
        }

        const startPos = new vscode.Position(startLine, 0);
        const endPos = new vscode.Position(endLine, document.lineAt(endLine).text.length);
        const range = new vscode.Range(startPos, endPos);

        let editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== fileUri.toString()) {
            editor = await vscode.window.showTextDocument(document);
        }

        const success = await editor.edit((editBuilder) => {
            editBuilder.replace(range, content);
        });

        if (success) {
            console.log(`[replaceWorkspaceFileLines] Lines replaced successfully`);

            await document.save();
            console.log(`[replaceWorkspaceFileLines] Document saved`);
        } else {
            throw new Error(`Failed to replace lines in file: ${fileUri.fsPath}`);
        }
    } catch (error) {
        console.error('[replaceWorkspaceFileLines] Error:', error);
        throw error;
    }
}

export function registerEditTools(server: McpServer): void {

    server.tool(
        'create_file_code',
        `Create or overwrite a file.`,
        {
            path: z.string().describe('The path to the file to create'),
            content: z.string().describe('The content to write to the file'),
            overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if the file exists'),
            ignoreIfExists: z.boolean().optional().default(false).describe('Whether to ignore if the file exists'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, content, overwrite = false, ignoreIfExists = false, workspace }): Promise<CallToolResult> => {
            console.log(`[create_file] Tool called with path=${path}, overwrite=${overwrite}, ignoreIfExists=${ignoreIfExists}`);

            try {
                console.log('[create_file] Creating file');
                await createWorkspaceFile(path, content, overwrite, ignoreIfExists, workspace);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `File ${path} created successfully`
                        }
                    ]
                };
                console.log('[create_file] Successfully completed');
                return result;
            } catch (error) {
                console.error('[create_file] Error in tool:', error);
                throw error;
            }
        }
    );

    server.tool(
        'replace_lines_code',
        `Replace lines in a file (exact match).`,
        {
            path: z.string().describe('The path to the file to modify'),
            startLine: z.number().describe('The start line number (1-based, inclusive)'),
            endLine: z.number().describe('The end line number (1-based, inclusive)'),
            content: z.string().describe('The new content to replace the lines with'),
            originalCode: z.string().describe('The original code for validation - must match exactly'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, startLine, endLine, content, originalCode, workspace }): Promise<CallToolResult> => {
            console.log(`[replace_lines_code] Tool called with path=${path}, startLine=${startLine}, endLine=${endLine}`);

            const zeroBasedStartLine = startLine - 1;
            const zeroBasedEndLine = endLine - 1;

            try {
                console.log('[replace_lines_code] Replacing lines');
                await replaceWorkspaceFileLines(path, zeroBasedStartLine, zeroBasedEndLine, content, originalCode, workspace);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Lines ${startLine}-${endLine} in file ${path} replaced successfully`
                        }
                    ]
                };
                console.log('[replace_lines_code] Successfully completed');
                return result;
            } catch (error) {
                console.error('[replace_lines_code] Error in tool:', error);
                throw error;
            }
        }
    );
}