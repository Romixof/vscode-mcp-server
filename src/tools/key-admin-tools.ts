import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
    createScopedKey, revokeScopedKey, listScopedKeyRecords, loadAllScopedKeyRecords
} from '../auth/scoped-keys';
import { generateAndStoreApiKey } from '../auth';
import { setApiKeyCache } from '../auth/keycache';
import { appendAudit } from '../auth/audit';



export function registerKeyAdminTools(server: McpServer): void {

    server.tool(
        'scope_keys_code',
        `Creates, lists and revokes scoped API keys (mcpk_ro_ / mcpk_std_ / mcpk_full_), which map to the existing OAuth presets: read-only is fs:read only, standard adds edits and shell, full adds network and memory. Administration is never granted to a scoped key.

WHEN TO USE: handing a remote client or a funnel a key that cannot do more than it needs. A leaked read-only key is an information leak, not remote code execution.

The secret is shown once and stored hashed. Key creation and revocation are audited.`,
        {
            action: z.enum(['create', 'list', 'revoke']).describe('Key administration action'),
            scope: z.enum(['read-only', 'standard', 'full']).optional().describe('create: access level of the new key'),
            label: z.string().optional().describe('create: short label, e.g. "mammouth-funnel" (shows up as client in the audit log)'),
            key_id: z.string().optional().describe('revoke: the key id from list'),
        },
        async ({ action, scope, label, key_id }): Promise<CallToolResult> => {
            try {
                if (action === 'create') {
                    if (!scope) {
                        throw new Error('create requires scope ("read-only", "standard" or "full")');
                    }
                    const { key, record } = await createScopedKey(scope, label ?? 'unlabeled');
                    return {
                        content: [{
                            type: 'text',
                            text: `Scoped key created — COPY IT NOW, it is never shown again:\n\n${key}\n\nid=${record.id} scope=${record.scope} label=${record.label}\nClient header: X-Api-Key or Authorization: Bearer <key>\nEvery call made with it appears in the audit log as client "key:${record.label}".`
                        }]
                    };
                }
                if (action === 'list') {
                    const records = await loadAllScopedKeyRecords();
                    if (records.length === 0) {
                        return { content: [{ type: 'text', text: 'No scoped keys exist yet. Create one: scope_keys_code(action="create", scope="read-only", label="...").' }] };
                    }
                    return { content: [{ type: 'text', text: `Scoped keys:\n\nid  scope  prefix  label  status  created\n\n${listScopedKeyRecords(records)}` }] };
                }

                if (!key_id) {
                    throw new Error('revoke requires key_id (from action="list")');
                }
                const rec = await revokeScopedKey(key_id);
                if (!rec) {
                    throw new Error(`No active scoped key with id "${key_id}".`);
                }
                return { content: [{ type: 'text', text: `Scoped key ${rec.id} (${rec.scope}, "${rec.label}") revoked — it stops authenticating on the NEXT request.` }] };
            } catch (error) {
                console.error('[scope_keys_code] Error:', error);
                throw error;
            }
        }
    );

    server.tool(
        'secret_rotate_code',
        `Regenerates the PRIMARY API key and invalidates the old one immediately, in one audited call.

WHEN TO USE: right after the key was pasted into a chat, committed to a file, or shared with anyone; and periodically as hygiene.

Effects: the new key is returned ONCE and stored in VS Code SecretStorage; the old key (settings.json or SecretStorage) stops working on the next request. Scoped mcpk_ keys are NOT affected. Update every connected client (Mammouth connector, funnels, scripts) with the new key.`,
        {
            confirm: z.boolean().optional().default(false).describe('Must be true — rotation instantly disconnects every client using the old key')
        },
        async ({ confirm = false }): Promise<CallToolResult> => {
            try {
                if (!confirm) {
                    return { content: [{ type: 'text', text: 'Refused: rotation instantly invalidates the current primary key. Re-run with confirm=true once every client is ready to be updated.' }] } as CallToolResult;
                }
                const newKey = await generateAndStoreApiKey();
                setApiKeyCache(newKey);
                appendAudit({ kind: 'token_revoked', client: 'key-admin', detail: 'primary api key rotated via secret_rotate_code' });
                return {
                    content: [{
                        type: 'text',
                        text: `PRIMARY API KEY ROTATED — COPY IT NOW, it is never shown again:\n\n${newKey}\n\nOld key invalidated immediately. Update all clients (Authorization: Bearer <key> or X-Api-Key). Scoped mcpk_ keys kept working. Event recorded in the audit log.`
                    }]
                };
            } catch (error) {
                console.error('[secret_rotate_code] Error:', error);
                throw error;
            }
        }
    );
}
