import * as crypto from 'crypto';
import type { Request } from 'express';
import { AuthConfig, extractToken, getStoredApiKey, tokensMatch } from '../auth';
import { PRESETS, ALL_SCOPES, Scope } from './scopes';
import { appendAudit } from './audit';



const STORAGE_KEY = 'vscode-mcp-server.scopedKeys';
const CACHE_TTL_MS = 3000;

export type ScopedKeyScope = keyof typeof PRESETS;

export interface ScopedKeyRecord {
    id: string;
    scope: ScopedKeyScope;
    label: string;
    hash: string;
    prefix: string;
    createdAt: number;
    revokedAt?: number;
}

let secretLoader: (() => PromiseLike<string | undefined>) | undefined;
let secretSaver: ((raw: string) => PromiseLike<void>) | undefined;


export function setScopedKeyStorage(storage: { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; }): void {
    secretLoader = () => storage.get(STORAGE_KEY);
    secretSaver = raw => storage.store(STORAGE_KEY, raw);
}

let cache: { records: ScopedKeyRecord[]; loadedAt: number } | undefined;

async function loadRaw(): Promise<string | undefined> {
    if (!secretLoader) { return undefined; }
    try {
        return await secretLoader();
    } catch {
        return undefined;
    }
}

function parseRecords(raw: string | undefined): ScopedKeyRecord[] {
    if (!raw) { return []; }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((r: unknown) => {
            const rec = r as ScopedKeyRecord;
            return rec && typeof rec.id === 'string' && typeof rec.hash === 'string';
        }) : [];
    } catch {
        return [];
    }
}

async function loadRecords(force = false): Promise<ScopedKeyRecord[]> {
    if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
        return cache.records;
    }
    const records = parseRecords(await loadRaw());
    cache = { records, loadedAt: Date.now() };
    return records;
}

async function saveRecords(records: ScopedKeyRecord[]): Promise<void> {
    cache = { records, loadedAt: Date.now() };
    if (!secretSaver) { return; }
    await secretSaver(JSON.stringify(records));
}


export function invalidateScopedKeyCache(): void {
    cache = undefined;
}

const SCOPE_TAG: Record<ScopedKeyScope, string> = { 'read-only': 'ro', 'standard': 'std', 'full': 'full' };

export function isScopedKey(presented: string): boolean {
    return presented.startsWith('mcpk_');
}

export interface CreateKeyResult { key: string; record: ScopedKeyRecord; }

export async function createScopedKey(scope: ScopedKeyScope, label: string): Promise<CreateKeyResult> {
    const raw = `mcpk_${SCOPE_TAG[scope]}_${crypto.randomBytes(24).toString('hex')}`;
    const record: ScopedKeyRecord = {
        id: crypto.randomBytes(4).toString('hex'),
        scope,
        label: label.slice(0, 40) || 'unlabeled',
        hash: crypto.createHash('sha256').update(raw).digest('hex'),
        prefix: raw.slice(0, 14),
        createdAt: Date.now()
    };
    const records = await loadRecords(true);
    if (records.filter(r => !r.revokedAt).length >= 20) {
        throw new Error('Scoped key limit reached (20 active). Revoke unused keys first: scope_keys_code(action="list").');
    }
    records.push(record);
    await saveRecords(records);
    appendAudit({ kind: 'key_created', client: 'key-admin', detail: `scope=${scope} id=${record.id} label=${record.label}` });
    return { key: raw, record };
}

export async function revokeScopedKey(id: string): Promise<ScopedKeyRecord | undefined> {
    const records = await loadRecords(true);
    const rec = records.find(r => r.id === id && !r.revokedAt);
    if (!rec) { return undefined; }
    rec.revokedAt = Date.now();
    await saveRecords(records);
    appendAudit({ kind: 'key_revoked', client: 'key-admin', detail: `id=${rec.id} scope=${rec.scope} label=${rec.label}` });
    return rec;
}

export function listScopedKeyRecords(records: ScopedKeyRecord[]): string {
    return records.map(r => {
        const status = r.revokedAt ? `REVOKED ${new Date(r.revokedAt).toISOString().slice(0, 10)}` : 'active';
        return `${r.id}  ${r.scope.padEnd(9)}  ${r.prefix}…  ${r.label}  ${status}  since ${new Date(r.createdAt).toISOString().slice(0, 10)}`;
    }).join('\n');
}


export async function loadAllScopedKeyRecords(): Promise<ScopedKeyRecord[]> {
    return loadRecords(true);
}

export interface KeyVerdict {
    ok: boolean;
    scopes: Scope[];
    client: string;
    viaScopedKey?: { id: string; scope: ScopedKeyScope };
}


export async function verifyApiKeyVerdict(req: Request, cfg: AuthConfig): Promise<KeyVerdict> {
    const none: KeyVerdict = { ok: false, scopes: [], client: 'api-key-client' };
    if (cfg.mode !== 'api-key') { return none; }
    const presented = extractToken(req.headers as Record<string, string | string[] | undefined>);
    if (!presented) { return none; }

    if (cfg.apiKey && tokensMatch(presented, cfg.apiKey)) {
        return { ok: true, scopes: [...ALL_SCOPES], client: 'api-key-client' };
    }
    const stored = await getStoredApiKey();
    if (stored && tokensMatch(presented, stored)) {
        return { ok: true, scopes: [...ALL_SCOPES], client: 'api-key-client' };
    }
    if (!isScopedKey(presented)) { return none; }

    const hash = crypto.createHash('sha256').update(presented).digest('hex');
    for (const rec of await loadRecords()) {
        if (rec.revokedAt) { continue; }
        if (tokensMatch(hash, rec.hash)) {
            return {
                ok: true,
                scopes: [...PRESETS[rec.scope]],
                client: `key:${rec.label}`,
                viaScopedKey: { id: rec.id, scope: rec.scope }
            };
        }
    }
    return none;
}
