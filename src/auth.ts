import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type AuthMode = 'session-token' | 'static-token' | 'oauth' | 'api-key' | 'none';

export interface AuthConfig {
	mode: AuthMode;
	staticToken?: string;
	apiKey?: string;
	allowedOrigins?: string[];
	allowNoOrigin?: boolean;
}

let _secretStorage: vscode.SecretStorage | undefined;

export function setSecretStorage(storage: vscode.SecretStorage): void {
	_secretStorage = storage;
}

/** Generates a cryptographically secure API key, stores it in VS Code SecretStorage (not in settings.json), and returns it. */
export async function generateAndStoreApiKey(): Promise<string> {
	const key = 'mcp_' + crypto.randomBytes(48).toString('base64url');
	if (_secretStorage) {
		await _secretStorage.store('vscode-mcp-server.apiKey', key);
	}
	return key;
}

export async function getStoredApiKey(): Promise<string | undefined> {
	if (!_secretStorage) {
		return undefined;
	}
	return await _secretStorage.get('vscode-mcp-server.apiKey');
}

export async function clearStoredApiKey(): Promise<void> {
	if (!_secretStorage) {
		return;
	}
	await _secretStorage.delete('vscode-mcp-server.apiKey');
}

export function readAuthConfig(): AuthConfig {
	const cfg = vscode.workspace.getConfiguration('vscode-mcp-server');
	return {
		mode: cfg.get<AuthMode>('auth.mode', 'session-token'),
		staticToken: cfg.get<string>('auth.staticToken', ''),
		apiKey: cfg.get<string>('auth.apiKey', ''),
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

export function verifyApiKey(req: Request, cfg: AuthConfig): boolean {
	if (cfg.mode !== 'api-key' || !cfg.apiKey) {
		return false;
	}
	const presented = extractToken(req.headers as Record<string, string | string[] | undefined>);
	return !!presented && tokensMatch(presented, cfg.apiKey);
}

/**
 * Async API key verification that also checks VS Code SecretStorage if the
 * key is not in settings.json. This allows the key to be stored securely
 * (in SecretStorage) rather than in plaintext settings.json.
 */
export async function verifyApiKeyAsync(req: Request, cfg: AuthConfig): Promise<boolean> {
	if (cfg.mode !== 'api-key') {
		return false;
	}
	const presented = extractToken(req.headers as Record<string, string | string[] | undefined>);
	if (!presented) {
		return false;
	}
	if (cfg.apiKey && tokensMatch(presented, cfg.apiKey)) {
		return true;
	}
	const stored = await getStoredApiKey();
	if (stored && tokensMatch(presented, stored)) {
		return true;
	}
	return false;
}
