import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type AuthMode = 'session-token' | 'static-token' | 'oauth' | 'none';

export interface AuthConfig {
	mode: AuthMode;
	staticToken?: string;
	allowedOrigins?: string[];
	allowNoOrigin?: boolean;
}

export function readAuthConfig(): AuthConfig {
	const cfg = vscode.workspace.getConfiguration('vscode-mcp-server');
	return {
		mode: cfg.get<AuthMode>('auth.mode', 'session-token'),
		staticToken: cfg.get<string>('auth.staticToken', ''),
		allowedOrigins: cfg.get<string[]>('auth.allowedOrigins', []),
		allowNoOrigin: cfg.get<boolean>('auth.allowNoOrigin', true),
	};
}

export function generateSessionToken(): string {
	return crypto.randomBytes(32).toString('base64url');
}

export function tokensMatch(presented: string, expected: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {return false;}
	return crypto.timingSafeEqual(a, b);
}

export function extractToken(headers: Record<string, string | string[] | undefined>): string | undefined {
	const authz = headers['authorization'];
	if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
		const t = authz.slice(7).trim();
		if (t) {return t;}
	}
	const alt = headers['x-mcp-token'];
	if (typeof alt === 'string' && alt.trim()) {return alt.trim();}
	return undefined;
}

export function originAllowed(origin: string | undefined, cfg: AuthConfig, selfPort: number): boolean {
	if (!origin) {return cfg.allowNoOrigin !== false;}
	const allowed = new Set([
		`http://127.0.0.1:${selfPort}`,
		`http://localhost:${selfPort}`,
		...(cfg.allowedOrigins ?? []),
	]);
	return allowed.has(origin);
}

export function originGuard(getCfg: () => AuthConfig, selfPort: number): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		if (originAllowed(req.headers.origin as string | undefined, getCfg(), selfPort)) {
			return next();
		}
		res.status(403).json({ error: 'forbidden_origin' });
	};
}

export function bearerAuth(getExpected: () => string | undefined): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		const expected = getExpected();
		if (!expected) {return next();}
		const presented = extractToken(req.headers as Record<string, string | string[] | undefined>);
		if (!presented || !tokensMatch(presented, expected)) {
			res.setHeader('WWW-Authenticate', 'Bearer realm="vscode-mcp-server", error="invalid_token"');
			return res.status(401).json({ error: 'invalid_token' });
		}
		next();
	};
}
