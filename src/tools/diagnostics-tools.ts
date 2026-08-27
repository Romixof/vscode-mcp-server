import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, workspaceDisplayPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';

function getDiagnostics(filePath?: string, workspace?: string): [vscode.Uri, vscode.Diagnostic[]][] {
    console.log(`[getDiagnostics] Starting with filePath: ${filePath || 'all files'}`);

    if (filePath) {
        const fileUri = resolveInputPath(filePath, workspace);
        console.log(`[getDiagnostics] Getting diagnostics for file: ${fileUri.fsPath}`);

        const diagnostics = vscode.languages.getDiagnostics(fileUri);
        return diagnostics.length > 0 ? [[fileUri, diagnostics]] : [];
    }

    console.log('[getDiagnostics] Getting diagnostics for all files');
    return vscode.languages.getDiagnostics();
}

function getSeverityName(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return 'Error';
        case vscode.DiagnosticSeverity.Warning:
            return 'Warning';
        case vscode.DiagnosticSeverity.Information:
            return 'Information';
        case vscode.DiagnosticSeverity.Hint:
            return 'Hint';
        default:
            return 'Unknown';
    }
}

function formatDiagnostics(
    diagnostics: [vscode.Uri, vscode.Diagnostic[]][],
    severities: vscode.DiagnosticSeverity[],
    format: 'text' | 'json' = 'text',
    includeSource: boolean = true
): string | object {
    console.log(`[formatDiagnostics] Format: ${format}, Include source: ${includeSource}`);

    const result: Array<{
        file: string;
        line: number;
        column: number;
        severity: string;
        message: string;
        source?: string;
    }> = [];

    let totalIssues = 0;

    for (const [uri, fileDiagnostics] of diagnostics) {
        const filePath = workspaceDisplayPath(uri);

        for (const diagnostic of fileDiagnostics) {

            if (!severities.includes(diagnostic.severity)) {
                continue;
            }

            totalIssues++;

            const issue = {
                file: filePath,
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                severity: getSeverityName(diagnostic.severity),
                message: diagnostic.message,
            };

            if (includeSource && diagnostic.source) {
                Object.assign(issue, { source: diagnostic.source });
            }

            result.push(issue);
        }
    }

    if (format === 'json') {
        return result;
    }

    if (result.length === 0) {
        return 'No issues found.';
    }

    let output = `Found ${totalIssues} issue(s):\n\n`;

    for (const issue of result) {
        output += `${issue.severity}: ${issue.file}:${issue.line}:${issue.column}\n`;
        output += `  ${issue.message}\n`;

        if (includeSource && issue.source) {
            output += `  Source: ${issue.source}\n`;
        }

        output += '\n';
    }

    return output;
}

export function registerDiagnosticsTools(server: McpServer): void {

    server.tool(
        'get_diagnostics_code',
        `Get VS Code diagnostics (errors/warnings).`,
        {
            path: z.string().optional().default('').describe('Optional file path to check. If not provided, checks the entire workspace. The file path must be a file, not a directory.'),
            severities: z.array(z.number()).optional().default([0, 1]).describe('Array of severity levels to include (0=Error, 1=Warning, 2=Information, 3=Hint)'),
            format: z.enum(['text', 'json']).optional().default('text').describe('Output format'),
            includeSource: z.boolean().optional().default(true).describe('Whether to include the diagnostic source to identify which linter/extension flagged each issue'),
            workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
        },
        async ({ path, severities = [0, 1], format = 'text', includeSource = true, workspace }): Promise<CallToolResult> => {
            console.log(`[get_diagnostics] Tool called with path=${path || 'all'}, severities=${severities.join(',')}, format=${format}`);

            try {
                console.log('[get_diagnostics] Getting diagnostics');
                const diagnostics = getDiagnostics(path, workspace);

                console.log(`[get_diagnostics] Found diagnostics for ${diagnostics.length} files`);
                const formattedResult = formatDiagnostics(diagnostics, severities, format, includeSource);

                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: format === 'json'
                                ? JSON.stringify(formattedResult, null, 2)
                                : formattedResult as string
                        }
                    ]
                };
                console.log('[get_diagnostics] Successfully completed');
                return result;
            } catch (error) {
                console.error('[get_diagnostics] Error in tool:', error);
                throw error;
            }
        }
    );
}