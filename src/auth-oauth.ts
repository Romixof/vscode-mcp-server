import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Router, json as expressJson, urlencoded as expressUrlencoded, type Request as ExpressRequest } from 'express';
import { tokensMatch } from './auth';
import { logger } from './utils/logger';
import { intersectScopes, PRESETS, Scope, scopeDescription } from './auth/scopes';
import { appendAudit } from './auth/audit';

interface RegisteredClient {
	client_id: string;
	client_secret?: string;
	redirect_uris: string[];
	client_name?: string;
	requestedScopes?: string;
	grantedScopes?: Scope[];
}

interface PendingGrant {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	code?: string;
	expiresAt: number;
	usedCode?: boolean;
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export interface OAuthHub {

	getAccessToken(): string | undefined;

	getLastClientName(): string | undefined;

	loadClients?(): Array<RegisteredClient>;
	saveClients?(clients: Array<RegisteredClient>): void;
}

const revokedClients = new Set<string>();

export function deriveAccessToken(secret: string, clientId: string): string {
	return crypto.createHmac('sha256', secret).update(`oauth:${clientId}`).digest('base64url');
}

export function isClientRevoked(clientId: string): boolean {
	return revokedClients.has(clientId);
}

export function revokeClient(clientId: string): void {
	revokedClients.add(clientId);
}

export function createOAuthRouter(selfPort: number, hub: OAuthHub): Router {
	const clients = new Map<string, RegisteredClient>();
	const grants = new Map<string, PendingGrant>();
	let lastClientName: string | undefined;

	for (const c of hub.loadClients?.() ?? []) {
		if (!c.grantedScopes) c.grantedScopes = intersectScopes(c.requestedScopes, PRESETS['standard']);
		clients.set(c.client_id, c);
	}
	function persistClients(): void {
		hub.saveClients?.([...clients.values()]);
	}

	const MAX_CLIENTS = 200;
	const MAX_PENDING_GRANTS = 50;

	setInterval(() => {
		const now = Date.now();
		for (const [id, g] of grants) {
			if (now > g.expiresAt || (g.usedCode ?? false)) {grants.delete(id);}
		}
	}, 60_000).unref();

	function pruneOldest<K, V>(map: Map<K, V>, cap: number): void {
		while (map.size >= cap) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) {break;}
			map.delete(oldest);
		}
	}

	function isPlausibleHostname(host: string): boolean {
		return /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?(:\d{1,5})?$/.test(host)
			&& !host.includes('..');
	}
	function publicOrigin(req: ExpressRequest): string {
		const host = req.headers['x-forwarded-host'] ?? req.headers.host;
		if (typeof host === 'string'
			&& !host.includes('127.0.0.1')
			&& !host.startsWith('localhost')
			&& !host.startsWith('[')
			&& isPlausibleHostname(host)) {
			return host.startsWith('http') ? host : `https://${host}`;
		}
		return `http://127.0.0.1:${selfPort}`;
	}

	const router = Router();

	router.get('/.well-known/oauth-protected-resource', (req, res) => {
		const origin = publicOrigin(req);

		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Vary', 'Host, X-Forwarded-Host');
		res.json({
			resource: origin,
			authorization_servers: [origin],
			scopes_supported: ['mcp'],
			bearer_methods_supported: ['header'],
		});
	});

	router.get('/.well-known/oauth-authorization-server', (req, res) => {
		const origin = publicOrigin(req);
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Vary', 'Host, X-Forwarded-Host');
		res.json({
			issuer: origin,
			registration_endpoint: `${origin}/register`,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/token`,
			revocation_endpoint: `${origin}/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['mcp'],
		});
	});

	router.post('/register', expressJson(), (req: ExpressRequest, res) => {
		const redirectUris = req.body?.redirect_uris;
		if (!Array.isArray(redirectUris) || redirect_uris_invalid(redirectUris)) {
			return res.status(400).json({ error: 'invalid_redirect_uri' });
		}
		const clientId = 'mcp-' + crypto.randomBytes(8).toString('hex');
		const client: RegisteredClient = {
			client_id: clientId,
			redirect_uris: redirectUris as string[],
			client_name: typeof req.body?.client_name === 'string' ? req.body.client_name : undefined,
			requestedScopes: typeof req.body?.scope === 'string' ? req.body.scope : undefined
		};
		pruneOldest(clients, MAX_CLIENTS);
		clients.set(clientId, client);
		persistClients();
		res.status(201).json({
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			redirect_uris: client.redirect_uris,
			client_name: client.client_name,
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code'],
			response_types: ['code'],
		});
	});

	router.get('/authorize', async (req, res) => {
		const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query as Record<string, string | undefined>;
		if (response_type !== 'code') {
			return res.status(400).json({ error: 'unsupported_response_type' });
		}
		const client = client_id ? clients.get(client_id) : undefined;
		if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
			return res.status(400).json({ error: 'invalid_client_or_redirect_uri' });
		}
		if (!code_challenge || code_challenge_method !== 'S256') {
			return res.status(400).json({ error: 'PKCE S256 is required', error_code: 'invalid_request' });
		}

		if (!/^[A-Za-z0-9_-]{43}$/.test(code_challenge)) {
			return res.status(400).json({ error: 'invalid_code_challenge', error_description: 'code_challenge must be 43 base64url chars (S256 of a valid verifier)' });
		}
		const grantId = crypto.randomBytes(16).toString('hex');
		pruneOldest(grants, MAX_PENDING_GRANTS);
		grants.set(grantId, {
			clientId: client.client_id,
			redirectUri: redirect_uri,
			codeChallenge: code_challenge,
			expiresAt: Date.now() + AUTH_CODE_TTL_MS,
		});
		lastClientName = client.client_name ?? client.client_id;

		const KNOWN: Array<[RegExp, string]> = [
			[/mammouth\.ai$/i, 'Mammouth'],
			[/claude\.ai$|anthropic\.com$/i, 'Claude'],
			[/chatgpt\.com$|openai\.com$/i, 'ChatGPT'],
			[/cursor\.(com|sh)$/i, 'Cursor'],
			[/codeium\.com$/i, 'Codeium'],
			[/gemini\.google\.com$|deepmind\.com$/i, 'Gemini'],
		];
		let cbHost = 'unknown';
		try {
			cbHost = new URL(redirect_uri).hostname;
		} catch {  }
		const known = KNOWN.find(([re]) => re.test(cbHost));
		const label = (client.client_name ?? '').trim() || known?.[1] || cbHost;
		const via = typeof req.headers.host === 'string' ? req.headers.host : `127.0.0.1:${selfPort}`;
		const ip = req.socket.remoteAddress?.replace('::ffff:', '') ?? 'unknown';
		const local = ip === '127.0.0.1' || ip === '::1';
		lastClientName = label;

		const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
		const answer = await new Promise<string | undefined>(resolve => {
			let settled = false;
			const done = (v: string | undefined) => {
				if (!settled) { settled = true; resolve(v); }
			};
			const timer = setTimeout(() => done('Deny'), CONSENT_TIMEOUT_MS);
			void vscode.window.showInformationMessage(
				`MCP authorization — ${label}`,
				{ modal: true, detail: `Client: ${label}${known ? ` (${known[1]})` : ''}\nCallback: ${redirect_uri}\nThrough: ${via}\nOrigin: ${ip}${local ? ' (this machine)' : ' (EXTERNAL)'}\n\nAccess level:\n- Read only: view files only\n- Standard: read + edit files + run commands in the sandbox\n- Full access: everything except administration` },
				'Read only',
				'Standard',
				'Full access',
				'Deny'
			).then(choice => {
				clearTimeout(timer);
				done(choice);
			});
		});
		const grant = grants.get(grantId);
		grants.delete(grantId);
		const presetName = answer === 'Read only' ? 'read-only'
			: answer === 'Standard' ? 'standard'
			: answer === 'Full access' ? 'full' : undefined;
		if (!grant || !presetName) {
			if (presetName === undefined && answer !== 'Deny') {
				appendAudit({ kind: 'consent_denied', client: label, detail: 'timeout or dismissed' });
			} else {
				appendAudit({ kind: 'consent_denied', client: label, detail: `preset=${answer}` });
			}
			const sep = redirect_uri.includes('?') ? '&' : '?';
			return res.redirect(302, `${redirect_uri}${sep}error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ''}`);
		}
		const grantedScopes = intersectScopes(client.requestedScopes, PRESETS[presetName]);
		client.grantedScopes = grantedScopes;
		persistClients();
		appendAudit({
			kind: 'consent_granted',
			client: label,
			detail: `preset=${presetName} scopes=[${grantedScopes.join(',')}] origin=${ip}`
		});
		const code = crypto.randomBytes(24).toString('base64url');
		grant.code = code;
		pruneOldest(grants, MAX_PENDING_GRANTS);
		grants.set(code, grant);
		const sep = redirect_uri.includes('?') ? '&' : '?';
		res.redirect(302, `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
	});

	router.get('/oauth/done', (req, res) => {
		const esc = (s: unknown): string => String(s ?? '')
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		const ok = Boolean(req.query.code) && !req.query.error;
		res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCP authorization</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#181818;color:#cccccc}
.card{max-width:440px;width:90%;background:#212121;border:1px solid #333;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.banner{padding:28px 24px;text-align:center;background:${ok ? '#1a2f26' : '#322226'};border-bottom:1px solid ${ok ? '#2d4a3e' : '#4a2d33'}}
.banner .icon{width:56px;height:56px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;background:${ok ? '#2ecc71' : '#e74c3c'};color:#fff}
.banner h1{font-size:1.25rem;color:${ok ? '#4ec9a6' : '#f48771'};font-weight:600}
.body{padding:20px 24px}
.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #2a2a2a;font-size:.86rem}
.row:last-child{border-bottom:none}
.row .k{color:#888;white-space:nowrap}
.row .v{text-align:right;word-break:break-all;color:#d0d0d0}
.actions{padding:0 24px 24px;display:flex;gap:10px}
button{flex:1;padding:11px;border:none;border-radius:6px;font-size:.92rem;font-weight:600;cursor:pointer}
.primary{background:#0e639c;color:#fff}
.primary:hover{background:#1177bb}
</style></head>
<body><div class="card">
<div class="banner"><div class="icon">${ok ? '&#10003;' : '&#10007;'}</div><h1>${ok ? 'Authorization complete' : 'Authorization failed'}</h1></div>
<div class="body">
${ok
	? `<div class="row"><span class="k">Status</span><span class="v">The authorization code was delivered to the client's callback URL.</span></div><div class="row"><span class="k">Next step</span><span class="v">Return to the client — it should connect within seconds.</span></div>`
	: `<div class="row"><span class="k">Reason</span><span class="v">${esc(req.query.error) || 'denied'}</span></div><div class="row"><span class="k">Next step</span><span class="v">Close this tab and start the connection again if this was a mistake.</span></div>`}
</div>
<div class="actions"><button class="primary" onclick="window.close()">Close this tab</button></div>
</div><script>setTimeout(()=>{try{window.close()}catch(e){}},8000)</script>
</body></html>`);
	});

	router.post('/token', expressUrlencoded({ extended: false }), async (req, res) => {
		const { grant_type, code, client_id, code_verifier, redirect_uri } = req.body as Record<string, string | undefined>;
		if (grant_type !== 'authorization_code') {
			return res.status(400).json({ error: 'unsupported_grant_type' });
		}
		const grant = typeof code === 'string' ? grants.get(code) : undefined;
		if (!grant || !grant.code || grant.usedCode || Date.now() > grant.expiresAt) {
			return res.status(400).json({ error: 'invalid_grant' });
		}
		if (client_id !== grant.clientId || redirect_uri !== grant.redirectUri) {
			return res.status(400).json({ error: 'invalid_grant' });
		}

		if (typeof code_verifier !== 'string' || !/^[A-Za-z0-9-._~]{43,128}$/.test(code_verifier)) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
		}
		const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
		if (!tokensMatch(expected, grant.codeChallenge)) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
		}
		grant.usedCode = true;
		grants.delete(code as string);
		const secret = hub.getAccessToken();
		if (!secret) {
			return res.status(503).json({ error: 'server_not_ready' });
		}
		if (isClientRevoked(client_id as string)) {
			return res.status(400).json({ error: 'invalid_grant', error_description: 'client is revoked' });
		}
		const tokenClient = clients.get(grant.clientId);
		const grantedScopes = tokenClient?.grantedScopes ?? ['fs:read'];
		const scopeKey = `${grant.clientId}|${grantedScopes.join(',')}`;
		res.json({
			access_token: deriveAccessToken(secret, scopeKey),
			token_type: 'Bearer',
			scope: grantedScopes.join(' '),
		});
	});

	router.post('/revoke', expressUrlencoded({ extended: false }), (req, res) => {
		const token = typeof req.body?.token === 'string' ? req.body.token : '';
		const secret = hub.getAccessToken();
		if (secret && token) {
			for (const clientId of clients.keys()) {
				const scopes = clients.get(clientId)?.grantedScopes ?? intersectScopes(clients.get(clientId)?.requestedScopes, PRESETS['standard']);
				const derived = deriveAccessToken(secret, `${clientId}|${scopes.join(',')}`);
				const legacy = deriveAccessToken(secret, clientId);
				if (tokensMatch(token, derived) || tokensMatch(token, legacy)) {
					revokeClient(clientId);
					appendAudit({ kind: 'token_revoked', client: clientId, detail: `scopes=[${scopes.join(',')}]` });
					break;
				}
				let revoked = false;
				for (const preset of Object.values(PRESETS)) {
					const alt = deriveAccessToken(secret, `${clientId}|${preset.join(',')}`);
					if (tokensMatch(token, alt)) {
						revokeClient(clientId);
						appendAudit({ kind: 'token_revoked', client: clientId, detail: `scopes=[${preset.join(',')}]` });
						revoked = true; break;
					}
				}
				if (revoked) break;
			}
		}
		res.status(200).end();
	});

	void lastClientName;

	return Object.assign(router, {
		verifyDerivedToken(token: string): { verdict: 'ok' | 'revoked' | 'unknown'; scopes: Scope[]; client?: string } {
			const secret = hub.getAccessToken();
			if (!secret) {return { verdict: 'unknown', scopes: [] };}
			for (const [clientId, client] of clients) {
				const scopes = client.grantedScopes ?? intersectScopes(client.requestedScopes, PRESETS['standard']);
				const derived = deriveAccessToken(secret, `${clientId}|${scopes.join(',')}`);
				const legacy = deriveAccessToken(secret, clientId);
				if (tokensMatch(token, derived) || tokensMatch(token, legacy)) {
					return isClientRevoked(clientId)
						? { verdict: 'revoked', scopes: [], client: clientId }
						: { verdict: 'ok', scopes, client: clientId };
				}
				for (const preset of Object.values(PRESETS)) {
					const alt = deriveAccessToken(secret, `${clientId}|${preset.join(',')}`);
					if (tokensMatch(token, alt)) {
						return isClientRevoked(clientId)
							? { verdict: 'revoked', scopes: [], client: clientId }
							: { verdict: 'ok', scopes: preset as Scope[], client: clientId };
					}
				}
			}
			return { verdict: 'unknown', scopes: [] };
		},
	});
}

function redirect_uris_invalid(uris: unknown[]): boolean {
	return uris.some(u => {
		if (typeof u !== 'string') return true;
		const okScheme = u.startsWith('https://') || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost');
		if (!okScheme) return true;

		try {
			const parsed = new URL(u);
			if (parsed.username || parsed.password) return true;
			if (u.includes('@')) return true;
		} catch {
			return true;
		}
		return false;
	});
}
