import * as crypto from 'crypto';
import * as dns from 'dns';

export type IpClass = 'loopback' | 'private' | 'linklocal' | 'cgnat' | 'unspecified' | 'public' | 'invalid';

function ipv4ToLong(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return null;
    }
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        const n = Number(part);
        if (n > 255) {
            return null;
        }
        out = out * 256 + n;
    }
    return out >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
    const a = ipv4ToLong(ip);
    const b = ipv4ToLong(base);
    if (a === null || b === null) {
        return false;
    }
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function ipv6ToBigInt(ip: string): bigint | null {
    let s = ip;
    const pct = s.indexOf('%');
    if (pct >= 0) {
        s = s.slice(0, pct);
    }
    const mapped = s.toLowerCase().match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
        const v4 = ipv4ToLong(mapped[1]);
        if (v4 === null) {
            return null;
        }
        return 0xFFFFn << 32n | BigInt(v4 >>> 0);
    }
    const doubleColon = s.indexOf('::');
    let head: string[] = [];
    let tail: string[] = [];
    if (doubleColon >= 0) {
        const h = s.slice(0, doubleColon);
        const t = s.slice(doubleColon + 2);
        head = h ? h.split(':') : [];
        tail = t ? t.split(':') : [];
        const fill = 8 - head.length - tail.length;
        if (fill < 1 && !(head.length === 0 && tail.length === 0)) {
            return null;
        }
    } else {
        head = s.split(':');
        if (head.length !== 8) {
            return null;
        }
    }
    const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
    if (groups.length !== 8) {
        return null;
    }
    let out = 0n;
    for (const g of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
            return null;
        }
        out = out << 16n | BigInt(parseInt(g, 16));
    }
    return out;
}

function inCidr6(ip: string, base: string, bits: number): boolean {
    const a = ipv6ToBigInt(ip);
    const b = ipv6ToBigInt(base);
    if (a === null || b === null) {
        return false;
    }
    if (bits === 0) {
        return true;
    }
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (a & mask) === (b & mask);
}

export function classifyIp(rawIp: string): IpClass {
    const ip = rawIp.trim().replace(/^\[|\]$/g, '');
    const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
    if (isV4) {
        if (inCidr4(ip, '127.0.0.0', 8)) {
            return 'loopback';
        }
        if (inCidr4(ip, '0.0.0.0', 8)) {
            return 'unspecified';
        }
        if (inCidr4(ip, '169.254.0.0', 16)) {
            return 'linklocal';
        }
        if (inCidr4(ip, '10.0.0.0', 8) || inCidr4(ip, '172.16.0.0', 12) || inCidr4(ip, '192.168.0.0', 16)) {
            return 'private';
        }
        if (inCidr4(ip, '100.64.0.0', 10)) {
            return 'cgnat';
        }
        if (inCidr4(ip, '224.0.0.0', 4) || ipv4ToLong(ip)! >= 0xF0000000) {
            return 'invalid';
        }
        return 'public';
    }
    const v6 = ipv6ToBigInt(ip);
    if (v6 === null) {
        const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/);
        if (mapped) {
            return classifyIp(mapped[1]);
        }
        return 'invalid';
    }
    if (inCidr6(ip, '::1', 128)) {
        return 'loopback';
    }
    if (inCidr6(ip, '::', 128)) {
        return 'unspecified';
    }
    if (inCidr6(ip, 'fe80::', 10)) {
        return 'linklocal';
    }
    if (inCidr6(ip, 'fc00::', 7)) {
        return 'private';
    }
    if (inCidr6(ip, '::ffff:0:0', 96)) {
        const v6b = ipv6ToBigInt(ip);
        if (v6b === null) {
            return 'invalid';
        }
        const low = Number(v6b & 0xFFFFFFFFn);
        const v4 = `${(low >>> 24) & 255}.${(low >>> 16) & 255}.${(low >>> 8) & 255}.${low & 255}`;
        return classifyIp(v4);
    }
    if (inCidr6(ip, 'ff00::', 8)) {
        return 'invalid';
    }
    return 'public';
}

export interface UrlSafetyOptions {
    allowLoopback?: boolean;
    allowPrivateNetwork?: boolean;
}

export interface SafeUrl {
    url: URL;
    resolved: string[];
}

export async function assertUrlSafe(rawUrl: string, opts: UrlSafetyOptions = {}): Promise<SafeUrl> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Blocked scheme ${url.protocol} — only http/https are allowed`);
    }
    let hostname = url.hostname;
    const literalV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    const literalV6 = hostname.includes(':');
    let addresses: string[];
    if (literalV4 || literalV6) {
        addresses = [hostname];
    } else {
        try {
            const resolved = await dns.promises.lookup(hostname, { all: true, verbatim: true });
            addresses = resolved.map(r => r.address);
        } catch {
            throw new Error(`DNS resolution failed for ${hostname}`);
        }
        if (addresses.length === 0) {
            throw new Error(`DNS resolution failed for ${hostname}`);
        }
    }
    for (const addr of addresses) {
        const cls = classifyIp(addr);
        if (cls === 'loopback') {
            if (opts.allowLoopback) {
                continue;
            }
            throw new Error(`Blocked: ${hostname} resolves to loopback address ${addr}`);
        }
        if (cls === 'linklocal') {



            throw new Error(`Blocked SSRF: ${hostname} resolves to link-local address ${addr} (cloud metadata range)`);
        }
        if (cls === 'private' || cls === 'cgnat' || cls === 'unspecified' || cls === 'invalid') {
            if (opts.allowPrivateNetwork) {
                continue;
            }
            throw new Error(`Blocked SSRF: ${hostname} resolves to ${cls} address ${addr}. Pass allowPrivateNetwork=true to reach internal/dev-network hosts.`);
        }
    }
    return { url, resolved: addresses };
}

export function maskSecret(value: string): string {
    const digest = crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
    return `[redacted len=${value.length} sha8=${digest}]`;
}

export const MAX_API_BODY_BYTES = 1024 * 1024;

export async function readBodyWithCap(response: { body: ReadableStream<Uint8Array> | null }, maxBytes: number = MAX_API_BODY_BYTES): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) {
        return { text: '', truncated: false };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let truncated = false;
    let text = '';
    const chunks: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            received += value.byteLength;
            if (received > maxBytes) {
                chunks.push(value.subarray(0, Math.max(0, value.byteLength - (received - maxBytes))));
                truncated = true;
                void reader.cancel().catch(() => undefined);
                break;
            }
            chunks.push(value);
        }
    }
    for (const chunk of chunks) {
        text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return { text, truncated };
}

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
