import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Router, json as expressJson, urlencoded as expressUrlencoded, type Request as ExpressRequest } from 'express';
import { tokensMatch } from './auth';

interface RegisteredClient {
	client_id: string;
	client_secret?: string;
	redirect_uris: string[];
	client_name?: string;
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

export function createOAuthRouter(selfPort: number, hub: OAuthHub): Router {
	const clients = new Map<string, RegisteredClient>();
	const grants = new Map<string, PendingGrant>();
	let lastClientName: string | undefined;

	for (const c of hub.loadClients?.() ?? []) {
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
			if (now > g.expiresAt || (g.usedCode ?? false)) grants.delete(id);
		}
	}, 60_000).unref();

	function pruneOldest<K, V>(map: Map<K, V>, cap: number): void {
		while (map.size >= cap) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
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
		// F16 — metadata must never be cached: a shared cache keyed without
		// the Host could serve one origin's discovery document to another.
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

		// Requester context: known-client recognition plus the network door
		// and origin the request came through.
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
		} catch { /* keep unknown */ }
		const known = KNOWN.find(([re]) => re.test(cbHost));
		const label = (client.client_name ?? '').trim() || known?.[1] || cbHost;
		const via = typeof req.headers.host === 'string' ? req.headers.host : `127.0.0.1:${selfPort}`;
		const ip = req.socket.remoteAddress?.replace('::ffff:', '') ?? 'unknown';
		const local = ip === '127.0.0.1' || ip === '::1';
		lastClientName = label;

		// Consent card with a hard timeout (F-INJ1): an ignored dialog must
		// resolve as a denial instead of leaving the request — and the
		// grant — hanging forever.
		const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
		const answer = await new Promise<string | undefined>(resolve => {
			let settled = false;
			const done = (v: string | undefined) => {
				if (!settled) { settled = true; resolve(v); }
			};
			const timer = setTimeout(() => done('Deny'), CONSENT_TIMEOUT_MS);
			void vscode.window.showInformationMessage(
				`MCP authorization — ${label}`,
				{ modal: true, detail: `Client: ${label}${known ? ` (${known[1]})` : ''}\nCallback: ${redirect_uri}\nThrough: ${via}\nOrigin: ${ip}${local ? ' (this machine)' : ' (EXTERNAL)'}\n\n"Allow" hands this window's tools to the requester.` },
				'Allow',
				'Deny'
			).then(choice => {
				clearTimeout(timer);
				done(choice);
			});
		});
		const grant = grants.get(grantId);
		grants.delete(grantId);
		if (!grant || answer !== 'Allow') {
			const sep = redirect_uri.includes('?') ? '&' : '?';
			return res.redirect(302, `${redirect_uri}${sep}error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ''}`);
		}
		const code = crypto.randomBytes(24).toString('base64url');
		grant.code = code;
		pruneOldest(grants, MAX_PENDING_GRANTS);
		grants.set(code, grant);
		const sep = redirect_uri.includes('?') ? '&' : '?';
		res.redirect(302, `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
	});

	router.get('/oauth/done', (req, res) => {
		const ok = req.query.code || !req.query.error;
		res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCP authorization</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc}
.box{max-width:520px;text-align:center;padding:2rem}
h1{font-size:1.3rem;color:${ok ? '#4ec9a6' : '#f48771'}}
code{background:#2a2a2a;padding:.2rem .4rem;border-radius:4px;font-size:.85em;word-break:break-all}</style></head>
<body><div class="box">
${ok
	? `<h1>&#10003; Authorization complete</h1><p>You can close this tab and return to the client. The authorization code has been delivered to your callback URL.</p>`
	: `<h1>&#10007; Authorization failed</h1><p>Reason: <code>${String(req.query.error)}</code>. Close this tab and try connecting again.</p>`}
<p style="margin-top:1.5rem"><button onclick="window.close()" style="padding:.5rem 1.5rem;font-size:1rem;cursor:pointer;background:#0e639c;color:#fff;border:none;border-radius:4px">Close this tab</button></p>
</div><script>setTimeout(()=>{try{window.close()}catch(e){}},4000)</script>
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
		const accessToken = hub.getAccessToken();
		if (!accessToken) {
			return res.status(503).json({ error: 'server_not_ready' });
		}
		res.json({
			access_token: accessToken,
			token_type: 'Bearer',
			scope: 'mcp',
		});
	});

	router.post('/revoke', expressUrlencoded({ extended: false }), (_req, res) => {
		res.status(200).end();
	});

	void lastClientName;

	return router;
}

function redirect_uris_invalid(uris: unknown[]): boolean {
	return uris.some(u => {
		if (typeof u !== 'string') return true;
		if (!(u.startsWith('https://') || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost'))) return true;
		// F13 — reject userinfo credentials smuggled into the authority:
		// https://user@evil.com/cb passes a naive startsWith check.
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
