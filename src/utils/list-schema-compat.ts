import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Keeps tools/list identical to what clients saw under zod 3.
 *
 * zod 4 converts schemas differently: objects lose additionalProperties:false,
 * every .int() gains ±2^53-1 bounds, and records gain propertyNames. Clients
 * that cached or validated the old shape (or reject propertyNames, as some
 * model providers do) would see a different contract for the same tools.
 */
export function normalizeListedSchema(node: unknown): unknown {
        if (Array.isArray(node)) {
                return node.map(normalizeListedSchema);
        }
        if (!node || typeof node !== 'object') {
                return node;
        }
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
                out[key] = normalizeListedSchema(value);
        }
        if (out.minimum === -Number.MAX_SAFE_INTEGER) {
                delete out.minimum;
        }
        if (out.maximum === Number.MAX_SAFE_INTEGER) {
                delete out.maximum;
        }
        const names = out.propertyNames as { type?: unknown } | undefined;
        if (names && Object.keys(names).length === 1 && names.type === 'string') {
                delete out.propertyNames;
        }
        if (out.type === 'object' && out.properties && Object.keys(out.properties).length > 0 && !('additionalProperties' in out)) {
                out.additionalProperties = false;
        }
        return out;
}

/** Wraps the SDK's tools/list handler; call after the first tool is registered. */
export function keepListedSchemasStable(server: McpServer): void {
        const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
        const original = handlers?.get('tools/list');
        if (!handlers || !original) {
                return;
        }
        handlers.set('tools/list', async (request, extra) => {
                const result = await original(request, extra) as { tools?: Array<Record<string, unknown>> };
                if (!Array.isArray(result?.tools)) {
                        return result;
                }
                return {
                        ...result,
                        tools: result.tools.map(tool => ({
                                ...tool,
                                inputSchema: normalizeListedSchema(tool.inputSchema),
                                ...(tool.outputSchema ? { outputSchema: normalizeListedSchema(tool.outputSchema) } : {})
                        }))
                };
        });
}
