export type AuditKind =
    | 'tool_call'
    | 'tool_denied'
    | 'shell_blocked'
    | 'sandbox_violation'
    | 'consent_granted'
    | 'consent_denied'
    | 'token_revoked';

export interface AuditEvent {
    ts: number;
    kind: AuditKind;
    client: string;
    detail: string;
}

const MAX_ENTRIES = 500;
const KEEP_AFTER_ROTATION = 400;

let loadFn: () => AuditEvent[] = () => [];
let saveFn: (events: AuditEvent[]) => void = () => {};
let buffer: AuditEvent[] | undefined;

function current(): AuditEvent[] {
    if (!buffer) {
        buffer = loadFn();
    }
    return buffer;
}

export function initAudit(load: () => AuditEvent[], save: (events: AuditEvent[]) => void): void {
    loadFn = load;
    saveFn = save;
    buffer = undefined;
}

export function appendAudit(event: Omit<AuditEvent, 'ts'> & { ts?: number }): void {
    const full: AuditEvent = { ts: Date.now(), ...event };
    full.detail = sanitizeDetail(full.detail);
    const list = current();
    list.push(full);
    if (list.length > MAX_ENTRIES) {
        const rotated: AuditEvent[] = list.slice(-KEEP_AFTER_ROTATION);
        rotated.unshift({
            ts: Date.now(),
            kind: 'tool_call',
            client: 'system',
            detail: `audit log rotated, ${MAX_ENTRIES - KEEP_AFTER_ROTATION} oldest entries dropped`
        });
        buffer = rotated;
    }
    try {
        saveFn(buffer ?? []);
    } catch {
    }
}

export function getRecentAudit(limit = 50, filter?: { kind?: AuditKind; client?: string }): AuditEvent[] {
    let list = [...current()].reverse();
    if (filter?.kind) list = list.filter(e => e.kind === filter.kind);
    if (filter?.client) list = list.filter(e => e.client === filter.client);
    return list.slice(0, Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

export function auditSize(): number {
    return current().length;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064]/g;

function sanitizeDetail(detail: string): string {
    const cleaned = String(detail ?? '').replace(CONTROL_CHARS, '');
    return cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned;
}
