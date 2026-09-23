import type { RequestHandler } from 'express';



export const RATE_LIMIT_WINDOW_MS = 60000;
export const RATE_LIMIT_MAX_PER_WINDOW = 240;
export const RATE_LIMIT_GLOBAL_MAX_PER_WINDOW = 600;
const RATE_LIMIT_MAX_ENTRIES = 5000;

interface HitEntry { count: number; resetAt: number; }

const limiterMaps = new Set<Map<string, HitEntry>>();

function pruneAll(now: number): void {
    for (const hits of limiterMaps) {
        if (hits.size <= RATE_LIMIT_MAX_ENTRIES) { continue; }
        for (const [k, v] of hits) {
            if (v.resetAt <= now) { hits.delete(k); }
        }
        if (hits.size > RATE_LIMIT_MAX_ENTRIES) { hits.clear(); }
    }
}

function clientIp(req: { headers: Record<string, unknown>; socket: { remoteAddress?: string } }): string {
    const forwarded = req.headers['x-forwarded-for'];
    const firstHop = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
    return firstHop || req.socket.remoteAddress || 'unknown';
}

export function makeRateLimiter(maxPerWindow: number = RATE_LIMIT_MAX_PER_WINDOW): RequestHandler {
    const hits = new Map<string, HitEntry>();
    limiterMaps.add(hits);
    return (req, res, next) => {
        const ip = clientIp(req);
        const now = Date.now();
        pruneAll(now);
        const entry = hits.get(ip);
        if (!entry || entry.resetAt <= now) {
            hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
            res.setHeader('X-RateLimit-Limit', String(maxPerWindow));
            res.setHeader('X-RateLimit-Remaining', String(maxPerWindow - 1));
            next();
            return;
        }
        entry.count += 1;
        if (entry.count > maxPerWindow) {
            const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSeconds));
            res.status(429).json({ error: 'rate_limited', retryAfterSeconds });
            return;
        }
        res.setHeader('X-RateLimit-Limit', String(maxPerWindow));
        res.setHeader('X-RateLimit-Remaining', String(maxPerWindow - entry.count));
        next();
    };
}

export interface RateLimitRow {
    ip: string;
    count: number;
    resetsInSeconds: number;
}


export function rateLimitSnapshot(top = 20): { windowMs: number; maxPerWindow: number; trackedIps: number; top: RateLimitRow[] } {
    const now = Date.now();
    pruneAll(now);
    const byIp = new Map<string, RateLimitRow>();
    for (const hits of limiterMaps) {
        for (const [ip, v] of hits) {
            if (v.resetAt <= now) { continue; }
            const row: RateLimitRow = { ip, count: v.count, resetsInSeconds: Math.max(0, Math.ceil((v.resetAt - now) / 1000)) };
            const prev = byIp.get(ip);

            if (!prev || row.count > prev.count) { byIp.set(ip, row); }
        }
    }
    const rows = [...byIp.values()];
    rows.sort((a, b) => b.count - a.count);
    return {
        windowMs: RATE_LIMIT_WINDOW_MS,
        maxPerWindow: RATE_LIMIT_MAX_PER_WINDOW,
        trackedIps: rows.length,
        top: rows.slice(0, Math.max(1, Math.min(top, 50)))
    };
}
