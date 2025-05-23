import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Type for file listing results
export type FileListingResult = Array<{path: string, type: 'file' | 'directory'}>;

// Type for the file listing callback function
export type FileListingCallback = (path: string, recursive: boolean) => Promise<FileListingResult>;

// Default maximum character count
const DEFAULT_MAX_CHARACTERS = 100000;

/**
 * Lists files and directories in the VS Code workspace
 * @param workspacePath The path within the workspace to list files from
 * @param recursive Whether to list files recursively
 * @returns Array of file and directory entries
 */
export async function listWorkspaceFiles(workspacePath: string, recursive: boolean = false): Promise<FileListingResult> {
    console.log(`[listWorkspaceFiles] Starting with path: ${workspacePath}, recursive: ${recursive}`);
    
    if (!vscode.workspace.workspaceFolders) {
        throw new Error('No workspace folder is open');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceUri = workspaceFolder.uri;
    
    // Create URI for the target directory
    const targetUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
    console.log(`[listWorkspaceFiles] Target URI: ${targetUri.fsPath}`);

    async function processDirectory(dirUri: vscode.Uri, currentPath: string = ''): Promise<FileListingResult> {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const result: FileListingResult = [];

        for (const [name, type] of entries) {
            const entryPath = currentPath ? path.join(currentPath, name) : name;
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
        const result = await processDirectory(targetUri);
        console.log(`[listWorkspaceFiles] Found ${result.length} entries`);
        return result;
    } catch (error) {
        console.error('[listWorkspaceFiles] Error:', error);
        throw error;
    }
}

/**
 * Reads a file from the VS Code workspace with character limit check
 * @param workspacePath The path within the workspace to the file
 * @param encoding Optional encoding to convert the file content to a string
 * @param maxCharacters Maximum character count (default: 100,000)
 * @param startLine The start line number (0-based, inclusive). Use -1 to read from the beginning.
 * @param endLine The end line number (0-based, inclusive). Use -1 to read to the end.
 * @returns File content as Uint8Array or string if encoding is provided
 */
export async function readWorkspaceFile(
    workspacePath: string, 
    encoding?: string | null, 
    maxCharacters: number = DEFAULT_MAX_CHARACTERS,
    startLine: number = -1,
    endLine: number = -1
): Promise<Uint8Array | string> {
    console.log(`[readWorkspaceFile] Starting with path: ${workspacePath}, encoding: ${encoding || 'none'}, maxCharacters: ${maxCharacters}, startLine: ${startLine}, endLine: ${endLine}`);
    
    if (!vscode.workspace.workspaceFolders) {
        throw new Error('No workspace folder is open');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceUri = workspaceFolder.uri;
    
    // Create URI for the target file
    const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
    console.log(`[readWorkspaceFile] File URI: ${fileUri.fsPath}`);

    try {
        // Read the file content as Uint8Array
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        console.log(`[readWorkspaceFile] File read successfully, size: ${fileContent.byteLength} bytes`);
        
        // If encoding is provided, convert to string and check character count
        if (encoding) {
            const textDecoder = new TextDecoder(encoding);
            const textContent = textDecoder.decode(fileContent);
            
            // Check if the character count exceeds the limit
            if (textContent.length > maxCharacters) {
                throw new Error(`File content exceeds the maximum character limit (${textContent.length} vs ${maxCharacters} allowed)`);
            }
            
            // If line numbers are specified and valid, extract just those lines
            if (startLine >= 0 || endLine >= 0) {
                // Split the content into lines
                const lines = textContent.split('\n');
                
                // Set effective start and end lines
                const effectiveStartLine = startLine >= 0 ? startLine : 0;
                const effectiveEndLine = endLine >= 0 ? Math.min(endLine, lines.length - 1) : lines.length - 1;
                
                // Validate line numbers
                if (effectiveStartLine >= lines.length) {
                    throw new Error(`Start line ${effectiveStartLine + 1} is out of range (1-${lines.length})`);
                }
                
                // Make sure endLine is not less than startLine
                if (effectiveEndLine < effectiveStartLine) {
                    throw new Error(`End line ${effectiveEndLine + 1} is less than start line ${effectiveStartLine + 1}`);
                }
                
                // Extract the requested lines and join them back together
                const partialContent = lines.slice(effectiveStartLine, effectiveEndLine + 1).join('\n');
                console.log(`[readWorkspaceFile] Returning lines ${effectiveStartLine + 1}-${effectiveEndLine + 1}, length: ${partialContent.length} characters`);
                return partialContent;
            }
            
            return textContent;
        } else {
            // For binary content, use byte length as approximation
            if (fileContent.byteLength > maxCharacters) {
                throw new Error(`File content exceeds the maximum character limit (approx. ${fileContent.byteLength} bytes vs ${maxCharacters} allowed)`);
            }
            
            // For binary files, we cannot extract lines, so we ignore startLine and endLine
            if (startLine >= 0 || endLine >= 0) {
                console.warn(`[readWorkspaceFile] Line numbers specified for binary file, ignoring`);
            }
            
            // Otherwise return the raw bytes
            return fileContent;
        }
    } catch (error) {
        console.error('[readWorkspaceFile] Error:', error);
        throw error;
    }
}

/**
 * Registers MCP file-related tools with the server
 * @param server MCP server instance
 * @param fileListingCallback Callback function for file listing operations
 */
export function registerFileTools(
    server: McpServer, 
    fileListingCallback: FileListingCallback
): void {
    // Add list_files tool
    server.tool(
        'list_files_code',
        `Use this tool to explore the directory structure of the VS Code workspace.

        Key features:
        - Returns a list of files and directories at the specified path
        - When 'recursive' is set to true, it includes all nested files and subdirectories
        
        Use cases:
        - Understanding project structure
        - Finding specific file types
        - Verifying file existence before read/modify operations
        
        Recommendation:
        Start by exploring the root directory with path='.' before diving into specific subdirectories.
        Do not EVER set 'recursive' to true in the root directory as the output may be too large.
        Instead, use it to explore specific subdirectories.
        `,
        {
            path: z.string().describe('The path to list files from'),
            recursive: z.boolean().optional().default(false).describe('Whether to list files recursively')
        },
        async ({ path, recursive = false }): Promise<CallToolResult> => {
            console.log(`[list_files] Tool called with path=${path}, recursive=${recursive}`);
            
            if (!fileListingCallback) {
                console.error('[list_files] File listing callback not set');
                throw new Error('File listing callback not set');
            }

            try {
                console.log('[list_files] Calling file listing callback');
                const files = await fileListingCallback(path, recursive);
                console.log(`[list_files] Callback returned ${files.length} items`);
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(files, null, 2)
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

    // Update read_file tool with line number parameters
    server.tool(
        'read_file_code',
        `Use this tool to retrieve and analyze the contents of a file in the VS Code workspace.

        Key features:
        - Returns text content with optional encoding support (default: utf-8)
        - Enforces character limit (default: 100,000) to prevent loading large files
        - Supports partial file reading using line numbers (startLine and endLine)
        
        Use cases:
        - Understanding existing code implementations
        - Analyzing code patterns and dependencies
        - Reviewing configuration files
        - Extracting specific sections of large files
        
        Recommendation:
        Use startLine and endLine parameters for large files to read only the relevant portions.
        For text files, utf-8 encoding is recommended unless another encoding is specifically needed.`,
        {
            path: z.string().describe('The path to the file to read'),
            encoding: z.string().optional().default('utf-8').describe('Optional encoding to convert the file content to a string'),
            maxCharacters: z.number().optional().default(DEFAULT_MAX_CHARACTERS).describe('Maximum character count (default: 100,000)'),
            startLine: z.number().optional().default(-1).describe('The start line number (1-based, inclusive). Default: read from beginning, denoted by -1'),
            endLine: z.number().optional().default(-1).describe('The end line number (1-based, inclusive). Default: read to end, denoted by -1')
        },
        async ({ path, encoding = 'utf-8', maxCharacters = DEFAULT_MAX_CHARACTERS, startLine = -1, endLine = -1 }): Promise<CallToolResult> => {
            console.log(`[read_file] Tool called with path=${path}, encoding=${encoding || 'none'}, maxCharacters=${maxCharacters}, startLine=${startLine}, endLine=${endLine}`);
            
            // Convert 1-based input to 0-based for VS Code API
            const zeroBasedStartLine = startLine > 0 ? startLine - 1 : startLine;
            const zeroBasedEndLine = endLine > 0 ? endLine - 1 : endLine;
            
            try {
                console.log('[read_file] Reading file');
                const content = await readWorkspaceFile(path, encoding, maxCharacters, zeroBasedStartLine, zeroBasedEndLine);
                
                let resultContent: string;
                if (content instanceof Uint8Array) {
                    // For binary data, convert to base64
                    const base64 = Buffer.from(content).toString('base64');
                    resultContent = `Binary file, base64 encoded: ${base64}`;
                    console.log(`[read_file] File read as binary, base64 length: ${base64.length}`);
                } else {
                    // For text data, return as is
                    resultContent = content;
                    console.log(`[read_file] File read as text, length: ${content.length} characters`);
                }
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: resultContent
                        }
                    ]
                };
                console.log('[read_file] Successfully completed');
                return result;
            } catch (error) {
                console.error('[read_file] Error in tool:', error);
                throw error;
            }
        }
    );
}