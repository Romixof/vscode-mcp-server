import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { resolveInputPath, listWorkspaceFolders, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

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

function workspaceDisplayPath(uri: vscode.Uri): string {
    const folders = listWorkspaceFolders();
    if (folders.length === 0) {
        return uri.fsPath;
    }

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const relative = path.relative(root, uri.fsPath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return folders.length > 1 ? `${folder.name}/${relative}` : relative;
        }
    }

    const relativePath = path.relative(folders[0].uri.fsPath, uri.fsPath);
    return relativePath;
}

async function getPreview(uri: vscode.Uri, line?: number): Promise<string | undefined> {
    if (line === undefined) {
        return undefined;
    }

    try {

        const documents = vscode.workspace.textDocuments;
        let document = documents.find(doc => doc.uri.toString() === uri.toString());

        if (!document) {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(content).toString('utf8');
                const lines = text.split(/\r?\n/);

                if (line >= 0 && line < lines.length) {
                    return lines[line].trim();
                }
            } catch (error) {
                logger.warn(`[getPreview] Could not read file: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        } else {

            if (line >= 0 && line < document.lineCount) {
                return document.lineAt(line).text.trim();
            }
        }
    } catch (error) {
        logger.warn(`[getPreview] Error getting preview: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
}

async function getLineText(uri: vscode.Uri, line: number): Promise<string | undefined> {
    try {

        const document = await vscode.workspace.openTextDocument(uri);

        if (line >= 0 && line < document.lineCount) {
            return document.lineAt(line).text;
        }
        return undefined;
    } catch (error) {
        logger.warn(`[getLineText] Error getting line text: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

function findSymbolInLine(lineText: string, symbolName: string): number {
    return lineText.indexOf(symbolName);
}

function processHoverContent(content: any): string {
    if (typeof content === 'string') {
        return content;
    } else if (content && typeof content === 'object' && 'value' in content) {
        return content.value;
    }
    return String(content);
}

export async function getSymbolHoverInfo(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<{
    hovers: Array<{
        contents: string[];
        range?: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
        preview?: string;
    }>;
}> {
    logger.info(`[getSymbolHoverInfo] Getting hover info for ${uri.toString()} at position (${position.line},${position.character})`);

    try {

        const commandResult = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            uri,
            position
        ) || [];

        logger.info(`[getSymbolHoverInfo] Found ${commandResult.length} hover results`);

        const hovers = await Promise.all(commandResult.map(async hover => {

            let contents: string[] = [];

            if (Array.isArray(hover.contents)) {
                contents = hover.contents.map(processHoverContent);
            } else if (hover.contents) {
                contents = [processHoverContent(hover.contents)];
            }

            const range = hover.range ? {
                start: {
                    line: hover.range.start.line,
                    character: hover.range.start.character
                },
                end: {
                    line: hover.range.end.line,
                    character: hover.range.end.character
                }
            } : undefined;

            const preview = await getPreview(uri, hover.range?.start.line);

            return { contents, range, preview };
        }));

        return { hovers };
    } catch (error) {
        logger.error(`[getSymbolHoverInfo] Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

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

        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query
        ) || [];

        logger.info(`[searchWorkspaceSymbols] Found ${symbols.length} symbols`);

        const totalCount = symbols.length;

        const limitedSymbols = symbols.slice(0, maxResults);

        const result = {
            symbols: limitedSymbols.map(symbol => {
                const formatted = {
                    name: symbol.name,
                    kind: symbolKindToString(symbol.kind),
                    location: `${workspaceDisplayPath(symbol.location.uri)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character}`,
                    range: {
                        start: {
                            line: symbol.location.range.start.line + 1,
                            character: symbol.location.range.start.character
                        },
                        end: {
                            line: symbol.location.range.end.line + 1,
                            character: symbol.location.range.end.character
                        }
                    }
                };

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

export async function getDocumentSymbols(
    uri: vscode.Uri,
    maxDepth?: number
): Promise<{
    symbols: Array<{
        name: string;
        detail?: string;
        kind: string;
        range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
        selectionRange: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
        depth: number;
        children?: any[];
    }>;
    total: number;
    totalByKind: Record<string, number>;
}> {
    logger.info(`[getDocumentSymbols] Getting symbols for ${uri.toString()}, maxDepth: ${maxDepth}`);

    try {

        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            uri
        ) || [];

        logger.info(`[getDocumentSymbols] Found ${symbols.length} top-level symbols`);

        const flatSymbols: any[] = [];
        const kindCounts: Record<string, number> = {};

        function processSymbols(symbols: vscode.DocumentSymbol[], depth: number = 0) {
            for (const symbol of symbols) {

                if (maxDepth !== undefined && depth > maxDepth) {
                    continue;
                }

                const kindString = symbolKindToString(symbol.kind);
                kindCounts[kindString] = (kindCounts[kindString] || 0) + 1;

                const processedSymbol = {
                    name: symbol.name,
                    detail: symbol.detail || undefined,
                    kind: kindString,
                    range: {
                        start: {
                            line: symbol.range.start.line + 1,
                            character: symbol.range.start.character
                        },
                        end: {
                            line: symbol.range.end.line + 1,
                            character: symbol.range.end.character
                        }
                    },
                    selectionRange: {
                        start: {
                            line: symbol.selectionRange.start.line + 1,
                            character: symbol.selectionRange.start.character
                        },
                        end: {
                            line: symbol.selectionRange.end.line + 1,
                            character: symbol.selectionRange.end.character
                        }
                    },
                    depth,
                    children: symbol.children && symbol.children.length > 0 ? symbol.children.length : undefined
                };

                flatSymbols.push(processedSymbol);

                if (symbol.children && symbol.children.length > 0) {
                    processSymbols(symbol.children, depth + 1);
                }
            }
        }

        processSymbols(symbols);

        return {
            symbols: flatSymbols,
            total: flatSymbols.length,
            totalByKind: kindCounts
        };
    } catch (error) {
        logger.error(`[getDocumentSymbols] Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

export function registerSymbolTools(server: McpServer): void {

    server.tool(
        'search_symbols_code',
        `Searches for symbols (functions, classes, variables) across workspace using fuzzy matching.

        WHEN TO USE: Finding function/class definitions, exploring project structure, locating specific elements.

        Search: Supports partial terms (e.g., 'createW' matches 'createWorkspaceFile'). Returns location and container info.
        Limit results to avoid overwhelming output - increase maxResults only if needed.`,
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

    server.tool(
        'get_symbol_definition_code',
        `Gets definition information for a symbol using hover data (type, docs, source).

        WHEN TO USE: Understanding what a symbol represents, checking function signatures, quick API reference.
        USE search_symbols_code instead for: finding symbols by name across the project.

        Requires exact symbol name and line number. If symbol not found on line, returns clear message.`,
        {
            path: z.string().describe('The path to the file containing the symbol'),
            line: z.number().describe('The line number of the symbol (1-based)'),
            symbol: z.string().describe('The symbol name to look for on the specified line'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, line, symbol, workspace }): Promise<CallToolResult> => {
            logger.info(`[get_symbol_definition_code] Tool called with path="${path}", line=${line}, symbol="${symbol}"`);

            const zeroBasedLine = line - 1;
            try {
                const uri = resolveInputPath(path, workspace);

                try {
                    await vscode.workspace.fs.stat(uri);
                } catch (error) {
                    throw new Error(`File not found: ${path}`);
                }

                const lineText = await getLineText(uri, zeroBasedLine);
                if (!lineText) {
                    throw new Error(`Line ${line} not found in file: ${path}`);
                }

                const character = findSymbolInLine(lineText, symbol);
                if (character === -1) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Symbol "${symbol}" not found on line ${line} in file: ${path}`
                            }
                        ]
                    };
                }

                const position = new vscode.Position(zeroBasedLine, character);

                const hoverResult = await getSymbolHoverInfo(uri, position);

                let resultText: string;

                if (hoverResult.hovers.length === 0) {
                    resultText = `No definition information found for symbol "${symbol}" at ${path}:${line}:${character}.`;
                } else {
                    resultText = `Definition information for symbol "${symbol}" at ${path}:${line}:${character}:\n\n`;

                    for (const hover of hoverResult.hovers) {

                        if (hover.preview) {
                            resultText += `Code context: \`${hover.preview}\`\n\n`;
                        }

                        for (const content of hover.contents) {
                            resultText += `${content}\n\n`;
                        }

                        if (hover.range) {
                            resultText += `Symbol range: [${hover.range.start.line}:${hover.range.start.character}] to [${hover.range.end.line}:${hover.range.end.character}]\n\n`;
                        }
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
                logger.info('[get_symbol_definition_code] Successfully completed');
                return callResult;
            } catch (error) {
                logger.error(`[get_symbol_definition_code] Error in tool: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        }
    );

    server.tool(
        'get_document_symbols_code',
        `Gets complete symbol outline for a file showing hierarchical structure and line numbers.

        WHEN TO USE: Understanding file structure, getting overview of all symbols, finding symbol positions. This tool should be be preferred over reading the file using read_file_code when only an overview of the file is needed.
        USE search_symbols_code instead for: finding specific symbols by name across the project.

        Shows classes, functions, methods, variables with line ranges. Use maxDepth for large files to avoid deep nesting.`,
        {
            path: z.string().describe('The path to the file to analyze (relative to workspace)'),
            maxDepth: z.number().optional().describe('Maximum nesting depth to display (optional)'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, maxDepth, workspace }): Promise<CallToolResult> => {
            logger.info(`[get_document_symbols_code] Tool called with path="${path}", maxDepth=${maxDepth}`);

            try {
                const uri = resolveInputPath(path, workspace);

                try {
                    await vscode.workspace.fs.stat(uri);
                } catch (error) {
                    throw new Error(`File not found: ${path}`);
                }

                logger.info('[get_document_symbols_code] Getting document symbols');
                const result = await getDocumentSymbols(uri, maxDepth);

                let resultText: string;

                if (result.symbols.length === 0) {
                    resultText = `No symbols found in file: ${path}`;
                } else {
                    resultText = `Document symbols for ${path} (${result.total} total symbols):\n\n`;

                    const kindSummary = Object.entries(result.totalByKind)
                        .map(([kind, count]) => `${count} ${kind}${count !== 1 ? 's' : ''}`)
                        .join(', ');
                    resultText += `Summary: ${kindSummary}\n\n`;

                    for (const symbol of result.symbols) {
                        const indent = '  '.repeat(symbol.depth);
                        resultText += `${indent}${symbol.name} (${symbol.kind})`;

                        if (symbol.detail) {
                            resultText += ` - ${symbol.detail}`;
                        }

                        resultText += `\n${indent}  Range: ${symbol.range.start.line}:${symbol.range.start.character}-${symbol.range.end.line}:${symbol.range.end.character}`;

                        if (symbol.children !== undefined) {
                            resultText += ` | Children: ${symbol.children}`;
                        }

                        resultText += '\n\n';
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
                logger.info('[get_document_symbols_code] Successfully completed');
                return callResult;
            } catch (error) {
                logger.error(`[get_document_symbols_code] Error in tool: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        }
    );
}