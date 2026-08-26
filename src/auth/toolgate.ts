import { AsyncLocalStorage } from 'async_hooks';
import { appendAudit } from './audit';
import { scopeAllows } from './scopes';
import type { Scope } from './scopes';

const callContext = new AsyncLocalStorage<{ scopes: Scope[]; client: string }>();

export function runWithScopes<T>(scopes: Scope[], client: string, fn: () => T): T {
    return callContext.run({ scopes, client }, fn);
}

export function currentScopes(): { scopes: Scope[]; client: string } {
    const store = callContext.getStore();
    return store ?? { scopes: [], client: 'unknown' };
}

export function checkToolAccess(toolName: string, granted: Scope[], client: string): { allowed: boolean; reason?: string } {
    if (scopeAllows(granted, toolName)) {
        return { allowed: true };
    }
    appendAudit({
        kind: 'tool_denied',
        client,
        detail: `${toolName} (granted: ${granted.join(',') || 'none'})`
    });
    return { allowed: false, reason: `Tool "${toolName}" is not permitted by the granted access level (${granted.join(', ') || 'none'})` };
}
