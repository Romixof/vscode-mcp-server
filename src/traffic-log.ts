import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RequestHandler, Request, Response, NextFunction } from 'express';


const MAX_FILE_BYTES = 2 * 1024 * 1024;   
const LOG_BODY_MAX = 200;                 

let trafficFile = '';
let rotating = false;

export function trafficLogPath(): string {
    return process.env.VSCODE_MCP_TRAFFIC_LOG
        || path.join(os.homedir(), '.vscode-mcp-server', 'traffic.log');
}


export function initTrafficLog(banner: string): void {
    try {
        trafficFile = trafficLogPath();
        fs.mkdirSync(path.dirname(trafficFile), { recursive: true });
    } catch {
        
        trafficFile = '';
        return;
    }
    writeLine(`=== ${banner} ===`);
}


export function writeLine(line: string): void {
    if (!trafficFile) {return;}
    try {
        if (!rotating) {
            try {
                const st = fs.statSync(trafficFile);
                if (st.size > MAX_FILE_BYTES) {
                    rotating = true;
                    try {fs.renameSync(trafficFile, `${trafficFile}.1`);} catch {}
                    rotating = false;
                }
            } catch { /* fichier pas encore créé */ }
        }
        fs.appendFileSync(trafficFile, `${new Date().toISOString()} ${line}\n`);
    } catch { /* le logging ne doit jamais casser le serveur */ }
}

function trunc(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
}


function redactUrl(u: string): string {
    return u.replace(/([?&]key=)[^&\s]*/gi, '$1***');
}

function maskSecret(v: string): string {
    if (v.length <= 8) {return `*** (len=${v.length})`;}
    return `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})`;
}


function authSummary(h: Record<string, unknown>): string {
    const authz = h['authorization'];
    const xkey = h['x-api-key'];
    const xtok = h['x-mcp-token'];
    if (typeof authz === 'string' && authz.trim()) {
        const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
        return m
            ? `auth=Bearer ${maskSecret(m[1].trim())}`
            : `auth=Authorization-non-Bearer(${trunc(authz.trim(), 14)})`;
    }
    if (Array.isArray(authz)) {return 'auth=Authorization(multi)';}
    if (typeof xkey === 'string' && xkey.trim()) {return `auth=X-Api-Key ${maskSecret(xkey.trim())}`;}
    if (typeof xtok === 'string' && xtok.trim()) {return `auth=X-Mcp-Token ${maskSecret(xtok.trim())}`;}
    return 'auth=AUCUNE';
}


export function trafficMiddleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!trafficFile) {return next();}
        const started = Date.now();
        const h = req.headers as Record<string, unknown>;
        const url = redactUrl(req.originalUrl ?? req.url);
        const ip = (h['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
            || req.socket.remoteAddress?.replace('::ffff:', '')
            || 'unknown';

        const parts = [
            `→ ${req.method} ${url}`,
            `ip=${ip}`,
            `host=${(h['host'] as string | undefined) ?? '-'}`,
            `origin=${(h['origin'] as string | undefined) ?? '-'}`,
            `ua=${trunc((h['user-agent'] as string | undefined) ?? '-', 48)}`,
            authSummary(h),
            `ctype=${(h['content-type'] as string | undefined) ?? '-'}`,
            `accept=${trunc((h['accept'] as string | undefined) ?? '-', 60)}`,
            `proto=${(h['x-forwarded-proto'] as string | undefined) ?? '-'}`
        ];
        const mcpv = h['mcp-protocol-version'];
        if (typeof mcpv === 'string' && mcpv) {parts.push(`mcpv=${mcpv}`);}
        writeLine(parts.join(' '));

        res.on('finish', () => {
            const ms = Date.now() - started;
            writeLine(`← ${req.method} ${url} → ${res.statusCode} (${ms}ms)`);
        });
        res.on('close', () => {
            if (!res.writableFinished) {
                const ms = Date.now() - started;
                writeLine(`✗ ${req.method} ${url} ABORTED après ${ms}ms (client déconnecté)`);
            }
        });
        next();
    };
}

const notedBodies = new WeakMap<object, string>();


export function trafficNoteBody(req: Request, body: unknown): void {
    try {
        if (!trafficFile || body === undefined || body === null) {return;}
        const flat = JSON.stringify(body).replace(/\s+/g, ' ');
        notedBodies.set(req, trunc(flat, LOG_BODY_MAX));
        writeLine(`↳ ${req.method} ${redactUrl(req.originalUrl ?? req.url)} body='${trunc(flat, LOG_BODY_MAX)}'`);
    } catch { /* jamais bloquer */ }
}


export function attachTrafficHooks(server: import('http').Server): void {
    let conns = 0;
    server.on('connection', (socket) => {
        try {
            conns += 1;
            const s = socket as import('net').Socket;
            writeLine(`⚡ TCP #${conns} depuis ${s.remoteAddress}:${s.remotePort}`);
        } catch { /* ignore */ }
    });
    server.on('clientError', (err, socket) => {
        const code = (err as NodeJS.ErrnoException).code;
        writeLine(`⚠ clientError: ${code ?? err.message}`);
        try {socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');} catch { /* ignore */ }
    });
}


export function readTrafficTail(lines: number): string {
    const max = Math.min(Math.max(1, Math.floor(lines)), 500);
    try {
        const raw = fs.readFileSync(trafficFile || trafficLogPath(), 'utf8');
        const arr = raw.split('\n').filter(l => l.trim().length > 0);
        return arr.slice(-max).join('\n') + '\n';
    } catch (err) {
        return `traffic log indisponible : ${err instanceof Error ? err.message : String(err)}\n`;
    }
}
