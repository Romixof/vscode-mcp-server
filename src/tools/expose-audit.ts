import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getRecentAudit, auditSize } from '../auth/audit';
import { rateLimitSnapshot } from '../auth/ratelimit';



interface ClientRow { calls: number; denied: number; lastTs: number; tools: Map<string, number>; }

export function registerExposeAuditTool(server: McpServer): void {
    server.tool(
        'expose_audit_code',
        `Aggregated exposure view of who is hitting this server: clients and their tool counts, denied/blocked events, and the current rate-limit window with the top source IPs.

WHEN TO USE: after exposing the server through Tailscale Funnel or any tunnel, to answer "who called what, from which address, and is anyone hammering the endpoint?" — without paging through the raw audit log (get_audit_log_code).

Read-only. Rate-limit counters cover the last 60 seconds (240 requests/IP window).`,
        {
            last: z.number().int().min(1).max(500).optional().default(200).describe('How many recent audit entries to aggregate'),
            topTools: z.number().int().min(1).max(20).optional().default(5).describe('Tools shown per client')
        },
        async ({ last = 200, topTools = 5 }): Promise<CallToolResult> => {
            try {
                const events = getRecentAudit(last).slice().reverse();
                const clients = new Map<string, ClientRow>();
                let denied = 0, blocked = 0, keyEvents = 0;

                for (const e of events) {
                    let client = e.client;
                    let tool: string | undefined;
                    if (e.kind === 'tool_call') { tool = e.detail; }
                    else if (e.kind === 'tool_denied') {
                        tool = e.detail.split(' (')[0];
                        denied += 1;
                    } else if (e.kind === 'shell_blocked') { blocked += 1; }
                    else if (e.kind === 'key_created' || e.kind === 'key_revoked' || e.kind === 'token_revoked') { keyEvents += 1; }

                    let row = clients.get(client);
                    if (!row) {
                        row = { calls: 0, denied: 0, lastTs: e.ts, tools: new Map() };
                        clients.set(client, row);
                    }
                    row.lastTs = Math.max(row.lastTs, e.ts);
                    if (e.kind === 'tool_call') { row.calls += 1; }
                    if (e.kind === 'tool_denied') { row.denied += 1; }
                    if (tool) {
                        row.tools.set(tool, (row.tools.get(tool) ?? 0) + 1);
                    }
                }

                const out: string[] = [];
                out.push(`Audit window: last ${events.length} entries (log holds ${auditSize()}), ${denied} denied, ${blocked} shell-blocked, ${keyEvents} key events.`);

                if (clients.size > 0) {
                    out.push('', 'CLIENTS (most recent first):');
                    const rows = [...clients.entries()].sort((a, b) => b[1].lastTs - a[1].lastTs);
                    for (const [client, row] of rows) {
                        const when = new Date(row.lastTs).toISOString().slice(5, 16).replace('T', ' ');
                        out.push(`- ${client}: ${row.calls} call(s), ${row.denied} denied, last ${when}`);
                        const tools = [...row.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, topTools);
                        if (tools.length > 0) {
                            out.push(`  top: ${tools.map(([t, n]) => `${t}×${n}`).join(', ')}`);
                        }
                    }
                } else {
                    out.push('No client activity in the selected window.');
                }

                const rl = rateLimitSnapshot(10);
                out.push('', `RATE LIMIT (window ${rl.windowMs / 1000}s, ${rl.maxPerWindow} req/IP): ${rl.trackedIps} IP(s) active in the current window.`);
                if (rl.top.length > 0) {
                    for (const row of rl.top) {
                        const pct = Math.round((row.count / rl.maxPerWindow) * 100);
                        out.push(`- ${row.ip}: ${row.count} req (${pct}% of limit, resets in ${row.resetsInSeconds}s)`);
                    }
                }

                return { content: [{ type: 'text', text: out.join('\n') }] };
            } catch (error) {
                console.error('[expose_audit_code] Error:', error);
                throw error;
            }
        }
    );
}
