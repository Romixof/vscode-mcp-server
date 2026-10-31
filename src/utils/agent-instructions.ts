import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_HINTS, ToolHints } from './tool-annotations';
import { searchCatalog, renderToolCard, compactCatalogIndex, CATALOG } from './tool-catalog';
import type { ToolMeta } from './tool-catalog';

/**
 * Size the compact index claims. Derived from TOOL_HINTS, and asserted equal
 * to the CATALOG/tool registry by the integrity tests, so a tool added to one
 * map but not the other fails loudly instead of drifting.
 */
const TOOL_CATALOG_SIZE = Object.keys(TOOL_HINTS).length;

/**
 * Full guide text: the workflow rules plus every tool as one detailed card.
 * Composed from the catalog so it cannot drift: every tool contributes one
 * detailed entry built from its card. The TOOL INDEX header states the card
 * count derived from TOOL_HINTS, and the TOOL BUDGET + EDIT RULE paragraphs
 * teach the partial-list and ambiguous-edit behavior, so the guide stays
 * self-sufficient for clients that only fetch this text.
 */
export const DEFAULT_AGENT_INSTRUCTIONS: string = [
        'You are working on an existing codebase through a VS Code workspace served by the "vscode-mcp-server" MCP server. This guide IS your complete tool map: do NOT call tools/list, do NOT explore to discover tools, do NOT guess tool names - every tool with its key parameters is listed below. Open every new conversation with ONE session_bootstrap_code() call: it returns memory + workspace layout + skills + this guide in a single response. That tool is absent from some client lists. When it is missing, ONE get_agent_instructions_code() call returns this same guide, so you are never left without it. When your client lists nothing but session_bootstrap_code, every tool still runs through the relay it provides (see TOOL BUDGET).',
        '',
        `TOOL INDEX (${TOOL_CATALOG_SIZE} tools — the full cards are listed below; lookup_tool_code(query) returns the exact signature, params, RO/MUT/DST class, when NOT to use it):`,
        '',
        'TOOL BUDGET: your client may expose only a subset of the tools below as callable — sometimes session_bootstrap_code alone. Every tool in the index IS callable by name even when unlisted, through the bootstrap relay: session_bootstrap_code(action="call", tool="<name>", args={...}) runs the named tool and returns its result. Fetch a card first when unsure of a signature — directly when listed: lookup_tool_code(query="<task>"), or via the relay: session_bootstrap_code(action="call", tool="lookup_tool_code", args={query:"<task>"}). Never claim a tool is unavailable without trying the relay; never silently skip the step. Never list a folder when the user already gave the path; never re-read a file you just wrote. Chain shell steps into one call (cmd1 && cmd2).',
        '',
        'EDIT RULE: change existing code with edit_file_code(path, old_string, new_string) — exact-text match, refuses ambiguity. If old_string matches more than once (2+ matches), nothing is applied: extend old_string with surrounding lines to make it unique, or pass replace_all=true to change every occurrence. create_file_code only for a new file or whole-file rewrite; replace_lines_code for a pure insertion/deletion at a known line; rename_symbol_code for renames — never manual search/replace.',
        '',
        `FULL TOOL CATALOG — ${TOOL_CATALOG_SIZE} detailed cards, one per tool with signature, params and RO/MUT/DST class:`,
        '',
        (Object.entries(CATALOG) as Array<[string, ToolMeta]>).map(([name, meta]) => `${renderToolCard({ name, meta, hints: TOOL_HINTS[name] ?? {} })}`).join('\n'),
        '',
        'LEGEND: [RO] = readOnlyHint, read-only, auto-approved, use freely. [MUT] modifies files or state, may need manual approval. [DST] destructive or runs arbitrary commands, needs approval. Multi-root: every path tool accepts workspace="<folder name or 1-based index>"; results come back as "FolderName/path" and resolve if you feed them back as-is.',
        '',
        'APPROVALS: [RO] tools are auto-approved - call them freely. [MUT] and [DST] may require manual approval - for multi-step modifications present a short plan first, then execute it.'
].join('\n');

export const AGENT_INSTRUCTIONS_VERSION = '25';

export function environmentSection(platform: NodeJS.Platform = process.platform): string {
        if (platform === 'win32') {
                return [
                        '',
                        'ENVIRONMENT (Windows conventions — get_server_info_code reports what this machine actually has):',
                        '- Interpreter: `python` or `py`, never `python3`, which is not a Windows executable name.',
                        '- Search with `grep`; `rg` may not be installed.',
                        '- Paths: `d:/...` or `/d/...` for a drive. A `/mnt/...` or a `C:` drive-letter path does not resolve in the integrated bash.',
                        '- Fonts: `fc-list` does not exist on Windows — never probe for fonts; render_pdf_pages_code and ocr_pdf_code need no system font query.',
                        '- Shell: read it, do not assume it. `get_server_info_code` reports the live one.'
                ].join('\n');
        }
        return [
                '',
                'ENVIRONMENT (platform conventions — get_server_info_code reports what this machine actually has):',
                `- Interpreter: \`python3\`. Platform is ${platform}.`
        ].join('\n');
}

/**
 * v17 shipped a ~30K-token catalog inline in the bootstrap answer, and clients
 * that keep tool results (Mammouth) re-posted it with every message. v18 serves
 * a compact guide instead: the abbreviated workflow rules plus a names-only
 * index grouped by section. The precise signature, parameter names and
 * approval class of the tools a task needs come from
 * lookup_tool_code(query), which scores the same catalog lexically (English
 * or French keywords) and returns only the few relevant cards.
 */
const WORKFLOW_RULES = [
        'You work in a VS Code workspace via the "vscode-mcp-server" MCP server.',
        '',
        'NON-NEGOTIABLE WORKFLOW:',
                '1. EVERY user message opens with session_bootstrap_code() — default mode="compact": a light re-anchor (workspace state only). Escalate ONLY if the task needs more: mode="full" for memory + layout + skills + guide, subfolder="<topic dir>" to scope a topic. Small one-off tasks stay compact.',
        '2. Explore: list_files_code (root: never recursive=true), read_file_code with ranges; get_document_symbols_code to outline, search_symbols_code to locate and define.',
        '3. Search text with search_workspace_code — NEVER shell commands for reading or searching files.',
        '4. Edit with edit_file_code (exact match, refuses ambiguity); create_file_code for new files; replace_lines_code to insert/delete at a line; rename_symbol_code for renames.',
        '5. After EVERY change batch run get_diagnostics_code(). Before ANY commit run find_secrets_code() then security_scan_code().',
        '6. Builds/tests: run_task_code / run_tests_code / build_project_code. Shell is LAST RESORT (~27s max); long runs: background_task_code, poll action="output".',
        '7. Web pages: browser_open_code(url) -> browser_snapshot_code() for uids -> browser_click_code / browser_fill_code -> snapshot again; browser_screenshot_code to see it (to show it to the user, paste the ![screenshot](url) it returns into your reply); everything else via browser_call_code(tool, args), tool="list" for the menu. Sensitive browser calls wait for the user to approve in VS Code.',
        '8. Never stop with work pending: handoff_code(inProgress, lastTool, nextStep) first, then report what remains; close finished work with ONE session_end_code(summary, …).',
        '',
        'TOOL BUDGET: some tools may be unlisted but every one IS callable through the relay: session_bootstrap_code(action="call", tool="<name>", args={...}). Fetch a card when unsure: lookup_tool_code(query="<task>"). Never claim a tool is unavailable without trying the relay. Never list a given folder; never re-read a file you just wrote. Chain shell steps (cmd1 && cmd2).',
        '',
        `TOOL INDEX (${TOOL_CATALOG_SIZE} tools — full card via lookup_tool_code(query)):`,
        compactCatalogIndex(),
        '',
        'LEGEND: [RO] auto-approved; [MUT]/[DST] may need approval. Path tools accept workspace="<folder name or 1-based index>".'
].join('\n');

export function resolveAgentInstructions(override?: string, platform: NodeJS.Platform = process.platform): string {
        const environment = environmentSection(platform);
        if (typeof override === 'string') {
                const trimmed = override.trim();
                if (trimmed.length > 0) {
                        return `${trimmed}\n${environment}`;
                }
        }
        return `${WORKFLOW_RULES}\n${environment}`;
}

export function resolveAgentInstructionsOverride(): string | undefined {
        return undefined;
}

export function registerAgentInstructionsTool(server: McpServer, getOverride?: () => string | undefined): void {
    server.tool('get_agent_instructions_code', `Returns the agent guide: workflow rules + compact TOOL INDEX of all ${TOOL_CATALOG_SIZE} tools; full cards via ONE lookup_tool_code(query). Read-only. The way in when session_bootstrap_code is not in your callable list: call once at conversation start; re-run after a server update.`, {}, async () => {
        const override = getOverride ? getOverride() : undefined;
        const text = resolveAgentInstructions(override);
        return { content: [{ type: 'text', text: `${text}\n\n[vscode-mcp-server agent guide v${AGENT_INSTRUCTIONS_VERSION}]` }] };
    });
}

export function registerLookupTool(server: McpServer): void {
    server.tool('lookup_tool_code', `Returns the full cards (signature, params, RO/MUT/DST class, keywords) of tools matching a task, English or French. Call this instead of guessing a signature. Read-only, auto-approved.`, {
        query: z.string().describe('The task, in your own words. Use several targeted keywords; avoid full sentences.'),
        limit: z.number().optional().default(8).describe('Max cards returned, 1-20, default 8.')
    }, async ({ query, limit = 8 }): Promise<CallToolResult> => {
        const cards = searchCatalog(query, limit);
        if (cards.length === 0) {
            return { content: [{ type: 'text', text: `No tool matches "${query}". Try shorter, concrete keywords (read, search, test, commit, pdf, memory…), or list the folder first to see what kind of thing you are handling.` }] };
        }
        const text = cards.map(renderToolCard).join('\n');
        return { content: [{ type: 'text', text }] };
    });
}
