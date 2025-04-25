import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Convert a symbol kind to a string representation
 * @param kind The symbol kind enum value
 * @returns String representation of the symbol kind
 */
function symbolKindToString(kind: vscode.SymbolKind): string {
    switch (kind) {
        case vscode.SymbolKind.File: return 'File';
        case vscode.SymbolKind.Module: return 'Module';
        case vscode.SymbolKind.Namespace: return 'Namespace';
        case vscode.SymbolKind.Package: return 'Package';
        case vscode.SymbolKind.Class: return 'Class';
        case vscode.SymbolKind.Method: return 'Method';
        case vscode.SymbolKind.Property: return 'Property';
        case vscode.SymbolKind.Field: return 'Field';
        case vscode.SymbolKind.Constructor: return 'Constructor';
        case vscode.SymbolKind.Enum: return 'Enum';
        case vscode.SymbolKind.Interface: return 'Interface';
        case vscode.SymbolKind.Function: return 'Function';
        case vscode.SymbolKind.Variable: return 'Variable';
        case vscode.SymbolKind.Constant: return 'Constant';
        case vscode.SymbolKind.String: return 'String';
        case vscode.SymbolKind.Number: return 'Number';
        case vscode.SymbolKind.Boolean: return 'Boolean';
        case vscode.SymbolKind.Array: return 'Array';
        case vscode.SymbolKind.Object: return 'Object';
        case vscode.SymbolKind.Key: return 'Key';
        case vscode.SymbolKind.Null: return 'Null';
        case vscode.SymbolKind.EnumMember: return 'EnumMember';
        case vscode.SymbolKind.Struct: return 'Struct';
        case vscode.SymbolKind.Event: return 'Event';
        case vscode.SymbolKind.Operator: return 'Operator';
        case vscode.SymbolKind.TypeParameter: return 'TypeParameter';
        default: return 'Unknown';
    }
}

/**
 * Converts a workspace URI to a path relative to the workspace root
 * @param uri The URI to convert
 * @returns Path relative to workspace root
 */
function uriToWorkspacePath(uri: vscode.Uri): string {
    if (!vscode.workspace.workspaceFolders) {
        return uri.fsPath;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceRoot = workspaceFolder.uri.fsPath;
    
    // Convert to relative path
    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    return relativePath;
}

/**
 * Search for symbols across the workspace
 * @param query The search query
 * @param maxResults Maximum number of results to return
 * @returns Array of formatted symbol information objects
 */
export async function searchWorkspaceSymbols(query: string, maxResults: number = 10): Promise<{
    symbols: Array<{
        name: string;
        kind: string;
        location: string;
        containerName?: string;
        range?: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
    }>;
    total: number;
}> {
    logger.info(`[searchWorkspaceSymbols] Starting with query: "${query}", maxResults: ${maxResults}`);
    
    try {
        // Execute the workspace symbol provider
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query
        ) || [];
        
        logger.info(`[searchWorkspaceSymbols] Found ${symbols.length} symbols`);
        
        // Get total count before limiting
        const totalCount = symbols.length;
        
        // Apply limit
        const limitedSymbols = symbols.slice(0, maxResults);
        
        // Format the results
        const result = {
            symbols: limitedSymbols.map(symbol => {
                const formatted = {
                    name: symbol.name,
                    kind: symbolKindToString(symbol.kind),
                    location: `${uriToWorkspacePath(symbol.location.uri)}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`,
                    range: {
                        start: {
                            line: symbol.location.range.start.line,
                            character: symbol.location.range.start.character
                        },
                        end: {
                            line: symbol.location.range.end.line,
                            character: symbol.location.range.end.character
                        }
                    }
                };
                
                // Add container name if available
                if (symbol.containerName) {
                    Object.assign(formatted, { containerName: symbol.containerName });
                }
                
                return formatted;
            }),
            total: totalCount
        };
        
        return result;
    } catch (error) {
        logger.error(`[searchWorkspaceSymbols] Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

/**
 * Registers MCP symbol-related tools with the server
 * @param server MCP server instance
 */
export function registerSymbolTools(server: McpServer): void {
    // Add search_symbols_code tool
    server.tool(
        'search_symbols_code',
        `Search for symbols across the VS Code workspace.

        Key features:
        - Finds symbols (functions, classes, variables, etc.) based on name matching
        - Returns location information for each symbol
        - Includes symbol kind and container information
        
        Use cases:
        - Finding definitions of symbols across the codebase
        - Exploring project structure and organization
        - Locating specific elements by name
        
        Notes:
        You may use partial search terms as the workspace symbol provider is designed for fuzzy matching.
        For example, searching for 'createW' might match 'createWorkspaceFile'.`,
        {
            query: z.string().describe('The search query for symbol names'),
            maxResults: z.number().optional().default(10).describe('Maximum number of results to return (default: 10)')
        },
        async ({ query, maxResults = 10 }): Promise<CallToolResult> => {
            logger.info(`[search_symbols_code] Tool called with query="${query}", maxResults=${maxResults}`);
            
            try {
                logger.info('[search_symbols_code] Searching workspace symbols');
                const result = await searchWorkspaceSymbols(query, maxResults);
                
                let resultText: string;
                
                if (result.symbols.length === 0) {
                    resultText = `No symbols found matching query "${query}".`;
                } else {
                    resultText = `Found ${result.total} symbols matching query "${query}"`;
                    
                    if (result.total > maxResults) {
                        resultText += ` (showing first ${maxResults})`;
                    }
                    
                    resultText += ":\n\n";
                    
                    for (const symbol of result.symbols) {
                        resultText += `${symbol.name} (${symbol.kind})`;
                        if (symbol.containerName) {
                            resultText += ` in ${symbol.containerName}`;
                        }
                        resultText += `\nLocation: ${symbol.location}\n\n`;
                    }
                }
                
                const callResult: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: resultText
                        }
                    ]
                };
                logger.info('[search_symbols_code] Successfully completed');
                return callResult;
            } catch (error) {
                logger.error(`[search_symbols_code] Error in tool: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        }
    );
}