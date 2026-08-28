import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveInputPath, listWorkspaceFolders, findOwningFolder, prefixDisplay, displayLabelFor, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type FileListingResult = Array<{path: string, type: 'file' | 'directory'}>;

export type FileListingCallback = (path: string, recursive: boolean, workspace?: string) => Promise<FileListingResult>;

const DEFAULT_MAX_CHARACTERS = 100000;

export async function listWorkspaceFiles(workspacePath: string, recursive: boolean = false, workspace?: string): Promise<FileListingResult> {
    console.log(`[listWorkspaceFiles] Starting with path: ${workspacePath}, recursive: ${recursive}`);

    const targetUri = resolveInputPath(workspacePath, workspace);
    console.log(`[listWorkspaceFiles] Target URI: ${targetUri.fsPath}`);

    const owner = findOwningFolder(targetUri);
    const rootPrefix =
        owner && prefixDisplay()
            ? displayLabelFor(owner)
            : owner
                ? ''
                : targetUri.fsPath.replace(/\\/g, '/');

    async function processDirectory(dirUri: vscode.Uri, currentPath: string = ''): Promise<FileListingResult> {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const result: FileListingResult = [];

        for (const [name, type] of entries) {

            const entryPath = currentPath ? `${currentPath}/${name}` : name;
            const itemType: 'file' | 'directory' = (type & vscode.FileType.Directory) ? 'directory' : 'file';

            result.push({ path: entryPath, type: itemType });

            if (recursive && itemType === 'directory') {
                const subDirUri = vscode.Uri.joinPath(dirUri, name);
                const subEntries = await processDirectory(subDirUri, entryPath);
                result.push(...subEntries);
            }
        }

        return result;
    }

    try {
        const result = await processDirectory(targetUri, rootPrefix);
        console.log(`[listWorkspaceFiles] Found ${result.length} entries`);
        return result;
    } catch (error) {
        console.error('[listWorkspaceFiles] Error:', error);
        throw error;
    }
}

function assertNotWorkspaceRoot(uri: vscode.Uri, action: string): void {
	const target = path.resolve(uri.fsPath);
	for (const folder of listWorkspaceFolders()) {
		const root = path.resolve(folder.uri.fsPath);

		if (target === root || target.toLowerCase() === root.toLowerCase()) {
			throw new Error(`Refusing to ${action} the workspace root "${folder.name}" itself — pass a path inside it.`);
		}
	}
}

export async function readWorkspaceFile(
    workspacePath: string,
    encoding: string = 'utf-8',
    maxCharacters: number = DEFAULT_MAX_CHARACTERS,
    startLine: number = -1,
    endLine: number = -1,
    workspace?: string
): Promise<string> {
    console.log(`[readWorkspaceFile] Starting with path: ${workspacePath}, encoding: ${encoding}, maxCharacters: ${maxCharacters}, startLine: ${startLine}, endLine: ${endLine}`);

    const fileUri = resolveInputPath(workspacePath, workspace);
    console.log(`[readWorkspaceFile] File URI: ${fileUri.fsPath}`);

    try {

        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        console.log(`[readWorkspaceFile] File read successfully, size: ${fileContent.byteLength} bytes`);

        if (encoding === 'base64') {

            if (maxCharacters > 0 && fileContent.byteLength > maxCharacters) {
                throw new Error(`File is ${fileContent.byteLength} bytes, over the ${maxCharacters} limit — base64 cannot be truncated; raise maxCharacters or pass 0 for no limit`);
            }

            if (startLine >= 0 || endLine >= 0) {
                console.warn(`[readWorkspaceFile] Line numbers specified for base64 encoding, ignoring`);
            }

            return Buffer.from(fileContent).toString('base64');
        } else {

            const textDecoder = new TextDecoder(encoding);
            let textContent = textDecoder.decode(fileContent);

            if (startLine >= 0 || endLine >= 0) {

                const lines = textContent.split('\n');

                const effectiveStartLine = startLine >= 0 ? startLine : 0;
                const effectiveEndLine = endLine >= 0 ? Math.min(endLine, lines.length - 1) : lines.length - 1;

                if (effectiveStartLine >= lines.length) {
                    throw new Error(`Start line ${effectiveStartLine + 1} is out of range (1-${lines.length})`);
                }

                if (effectiveEndLine < effectiveStartLine) {
                    throw new Error(`End line ${effectiveEndLine + 1} is less than start line ${effectiveStartLine + 1}`);
                }

                textContent = lines.slice(effectiveStartLine, effectiveEndLine + 1).join('\n');
                console.log(`[readWorkspaceFile] Returning lines ${effectiveStartLine + 1}-${effectiveEndLine + 1}, length: ${textContent.length} characters`);
            }

            if (maxCharacters > 0 && textContent.length > maxCharacters) {
                const note = `\n\n[File truncated: showing characters 1-${maxCharacters} of ${textContent.length}. Raise maxCharacters (0 = no limit) or use startLine/endLine to read specific sections.]`;
                return textContent.slice(0, maxCharacters) + note;
            }

            return textContent;
        }
    } catch (error) {
        console.error('[readWorkspaceFile] Error:', error);
        throw error;
    }
}

export function registerFileTools(
    server: McpServer,
    fileListingCallback: FileListingCallback,

    clusterFolders?: () => { lines: string[]; windowsFooter: string } | undefined
): void {
    server.tool(
        'list_workspace_folders_code',
        `Lists every root folder open in the window with its 1-based index and name.

WHEN TO USE: multi-root workspaces. The names and indices returned here are the values accepted by the optional "workspace" parameter of path-based tools.`,
        {},
        async (): Promise<CallToolResult> => {
            const folders = listWorkspaceFolders();
            if (folders.length === 0) {
                return { content: [{ type: 'text', text: 'No workspace folder is open.' }] };
            }
            const cluster = clusterFolders?.();
            if (cluster) {

                const text = [
                    `Open workspace folders (${cluster.lines.length}, cluster-wide):`,
                    ...cluster.lines,
                    `Windows: ${cluster.windowsFooter}`
                ].join('\n');
                return { content: [{ type: 'text', text }] };
            }
            const lines = folders.map((f, i) => `${i + 1}. ${f.name} -> ${f.uri.fsPath}`);
            return { content: [{ type: 'text', text: `Open workspace folders (${folders.length}):\n${lines.join('\n')}` }] };
        }
    );

    server.tool(
        'list_files_code',
        `Explores directory structure in VS Code workspace.

        WHEN TO USE: Understanding project structure, finding files before read/modify operations.

        CRITICAL: NEVER set recursive=true on root directory (.) - output too large. Use recursive only on specific subdirectories.

        Returns files and directories at specified path. Start with path='.' to explore root, then dive into specific subdirectories with recursive=true. Supports pagination via limit/offset for large directories.`,
        {
            path: z.string().describe('The path to list files from'),
            recursive: z.boolean().optional().default(false).describe('Whether to list files recursively'),
            limit: z.number().optional().default(100).describe('Max entries to return (1-500, default 100) — pagination only kicks in when needed'),
            offset: z.number().optional().default(0).describe('Skip this many entries (pagination offset)'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, recursive = false, limit = 100, offset = 0, workspace }): Promise<CallToolResult> => {
            console.log(`[list_files] Tool called with path=${path}, recursive=${recursive}`);

            if (!fileListingCallback) {
                console.error('[list_files] File listing callback not set');
                throw new Error('File listing callback not set');
            }

            try {
                console.log('[list_files] Calling file listing callback');
                const raw = await fileListingCallback(path, recursive, workspace) as unknown as FileListingResult | { files: FileListingResult };
                const files: FileListingResult = Array.isArray(raw) ? raw : (raw as { files: FileListingResult }).files ?? (raw as unknown as FileListingResult);
                console.log(`[list_files] Callback returned ${files.length} items`);
                const total = files.length;
                const capped = Math.min(Math.max(limit, 1), 500);
                const slice = files.slice(offset, offset + capped);
                const more = offset + slice.length < total;
                const payload = !more && offset === 0 && total <= capped
                    ? JSON.stringify(files, null, 2)
                    : JSON.stringify({ files: slice, total, offset, limit: capped, hasMore: more }, null, 2);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: payload
                        }
                    ]
                };
                console.log('[list_files] Successfully completed');
                return result;
            } catch (error) {
                console.error('[list_files] Error in tool:', error);
                throw error;
            }
        }
    );

    server.tool(
        'read_file_code',
        `Retrieves file contents with size limits and partial reading support.

        WHEN TO USE: Reading code, config files, analyzing implementations.

        Encoding: Text encodings (utf-8, latin1, etc.) for text files, 'base64' for base64-encoded string.
        Line numbers: Use startLine/endLine (1-based) for large files to read specific sections only.

        Files larger than maxCharacters are returned truncated, with a note at the end giving the full size — page through with startLine/endLine instead of retrying with a bigger limit.`,
        {
            path: z.string().describe('The path to the file to read'),
            encoding: z.string().optional().default('utf-8').describe('Encoding to convert the file content to a string. Use "base64" for base64-encoded string'),
            maxCharacters: z.number().optional().default(DEFAULT_MAX_CHARACTERS).describe('Maximum character count before truncation (default: 100,000). 0 disables the limit'),
            startLine: z.number().optional().default(-1).describe('The start line number (1-based, inclusive). Default: read from beginning, denoted by -1'),
            endLine: z.number().optional().default(-1).describe('The end line number (1-based, inclusive). Default: read to end, denoted by -1'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, encoding = 'utf-8', maxCharacters = DEFAULT_MAX_CHARACTERS, startLine = -1, endLine = -1, workspace }): Promise<CallToolResult> => {
            console.log(`[read_file] Tool called with path=${path}, encoding=${encoding}, maxCharacters=${maxCharacters}, startLine=${startLine}, endLine=${endLine}`);

            const zeroBasedStartLine = startLine > 0 ? startLine - 1 : startLine;
            const zeroBasedEndLine = endLine > 0 ? endLine - 1 : endLine;

            try {
                console.log('[read_file] Reading file');
                const content = await readWorkspaceFile(path, encoding, maxCharacters, zeroBasedStartLine, zeroBasedEndLine, workspace);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: content
                        }
                    ]
                };
                console.log(`[read_file] File read successfully, length: ${content.length} characters`);
                return result;
            } catch (error) {
                console.error('[read_file] Error in tool:', error);
                throw error;
            }
        }
    );

    server.tool(
        'move_file_code',
        `Moves a file or directory to a new location using VS Code's WorkspaceEdit API.

        WHEN TO USE: Reorganizing project structure, moving files between directories.

        This operation uses VS Code's refactoring capabilities to ensure imports and references are updated correctly.

        IMPORTANT: This will update all references to the moved file in the workspace.`,
        {
            sourcePath: z.string().describe('The current path of the file or directory to move'),
            targetPath: z.string().describe('The new path where the file or directory should be moved to'),
            overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if target already exists'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ sourcePath, targetPath, overwrite = false, workspace }): Promise<CallToolResult> => {
            console.log(`[move_file] Tool called with sourcePath=${sourcePath}, targetPath=${targetPath}, overwrite=${overwrite}`);

            const sourceUri = resolveInputPath(sourcePath, workspace);
            const targetUri = resolveInputPath(targetPath, workspace);
            assertNotWorkspaceRoot(sourceUri, 'move');

            try {
                console.log(`[move_file] Moving from ${sourceUri.fsPath} to ${targetUri.fsPath}`);

                const edit = new vscode.WorkspaceEdit();
                edit.renameFile(sourceUri, targetUri, { overwrite });

                const success = await vscode.workspace.applyEdit(edit);

                if (!success) {
                    throw new Error('Failed to apply file move operation; check if target and source are valid');
                }

                console.log('[move_file] File move completed successfully');

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully moved ${sourcePath} to ${targetPath}`
                        }
                    ]
                };
                return result;
            } catch (error) {
                console.error('[move_file] Error in tool:', error);
                throw error;
            }
        }
    );

    server.tool(
        'rename_file_code',
        `Renames a file or directory using VS Code's WorkspaceEdit API.

        WHEN TO USE: Renaming files to follow naming conventions, refactoring code.

        This operation uses VS Code's refactoring capabilities to ensure imports and references are updated correctly.

        IMPORTANT: This will update all references to the renamed file in the workspace.`,
        {
            filePath: z.string().describe('The current path of the file or directory to rename'),
            newName: z.string().describe('The new name for the file or directory'),
            overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if a file with the new name already exists'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ filePath, newName, overwrite = false, workspace }): Promise<CallToolResult> => {
            console.log(`[rename_file] Tool called with filePath=${filePath}, newName=${newName}, overwrite=${overwrite}`);

            const fileUri = resolveInputPath(filePath, workspace);
            assertNotWorkspaceRoot(fileUri, 'rename');
            const newFileUri = vscode.Uri.file(path.join(path.dirname(fileUri.fsPath), newName));

            try {
                console.log(`[rename_file] Renaming ${fileUri.fsPath} to ${newFileUri.fsPath}`);

                const edit = new vscode.WorkspaceEdit();
                edit.renameFile(fileUri, newFileUri, { overwrite });

                const success = await vscode.workspace.applyEdit(edit);

                if (!success) {
                    throw new Error('Failed to apply file rename operation; check if target and source are valid');
                }

                console.log('[rename_file] File rename completed successfully');

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully renamed ${filePath} to ${newName}`
                        }
                    ]
                };
                return result;
            } catch (error) {
                console.error('[rename_file] Error in tool:', error);
                throw error;
            }
        }
    );

    server.tool(
        'copy_file_code',
        `Copies a file to a new location.

        WHEN TO USE: Creating backups, duplicating files for testing, creating template files.

        LIMITATION: Only works for files, not directories.`,
        {
            sourcePath: z.string().describe('The path of the file to copy'),
            targetPath: z.string().describe('The path where the copy should be created'),
            overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if target already exists'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ sourcePath, targetPath, overwrite = false, workspace }): Promise<CallToolResult> => {
            console.log(`[copy_file] Tool called with sourcePath=${sourcePath}, targetPath=${targetPath}, overwrite=${overwrite}`);

            const sourceUri = resolveInputPath(sourcePath, workspace);
            const targetUri = resolveInputPath(targetPath, workspace);

            try {
                console.log(`[copy_file] Copying from ${sourceUri.fsPath} to ${targetUri.fsPath}`);

                let targetExists = false;
                try {
                    await vscode.workspace.fs.stat(targetUri);
                    targetExists = true;
                } catch (error) {

                    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {

                        targetExists = false;
                    } else {

                        throw error;
                    }
                }

                if (targetExists && !overwrite) {
                    throw new Error(`Target file ${targetPath} already exists. Use overwrite=true to overwrite.`);
                }

                const fileContent = await vscode.workspace.fs.readFile(sourceUri);

                await vscode.workspace.fs.writeFile(targetUri, fileContent);

                console.log('[copy_file] File copy completed successfully');

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully copied ${sourcePath} to ${targetPath}`
                        }
                    ]
                };
                return result;
            } catch (error) {
                console.error('[copy_file] Error in tool:', error);
                throw error;
            }
        }
    );
}