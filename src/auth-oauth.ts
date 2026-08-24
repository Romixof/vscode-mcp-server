import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Router, json as expressJson, urlencoded as expressUrlencoded } from 'express';
import { tokensMatch } from './auth';

/**
 * Minimal MCP OAuth 2.1 authorization server, scoped to what a local tool
 * server actually needs: dynamic client registration, authorization-code flow
 * with S256 PKCE, bearer tokens that ARE the session secret. No refresh
 * rotation — the token lives as long as the window does.
 *
 * Endpoints (all mounted under this router):
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-authorization-server
 *   POST /register          (dynamic client registration)
 *   GET  /authorize         (consent page → code)
 *   POST /token             (code + PKCE verifier → access token)
 *   POST /revoke            (accepted, best-effort)
 */

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
	code?: string;          // set once the user approves
	expiresAt: number;
	usedCode?: boolean;
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export interface OAuthHub {
	/** The access token issued through the flow: the session secret itself. */
	getAccessToken(): string | undefined;
	/** Human-readable client name shown on the consent prompt. */
	getLastClientName(): string | undefined;
}

export function createOAuthRouter(selfPort: number, hub: OAuthHub): Router {
	const clients = new Map<string, RegisteredClient>();
	const grants = new Map<string, PendingGrant>();
	let lastClientName: string | undefined;

	const router = Router();

	// ---------- metadata ----------
	router.get('/.well-known/oauth-protected-resource', (_req, res) => {
		res.json({
			resource: `http://127.0.0.1:${selfPort}`,
			authorization_servers: [`http://127.0.0.1:${selfPort}`],
			scopes_supported: ['mcp'],
			bearer_methods_supported: ['header'],
		});
	});

	router.get('/.well-known/oauth-authorization-server', (_req, res) => {
		res.json({
			issuer: `http://127.0.0.1:${selfPort}`,
			registration_endpoint: `http://127.0.0.1:${selfPort}/register`,
			authorization_endpoint: `http://127.0.0.1:${selfPort}/authorize`,
			token_endpoint: `http://127.0.0.1:${selfPort}/token`,
			revocation_endpoint: `http://127.0.0.1:${selfPort}/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['mcp'],
		});
	});

	// ---------- dynamic client registration ----------
	router.post('/register', (req, res) => {
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
		clients.set(clientId, client);
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

	// ---------- authorize (consent) ----------
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
		const grantId = crypto.randomBytes(16).toString('hex');
		grants.set(grantId, {
			clientId: client.client_id,
			redirectUri: redirect_uri,
			codeChallenge: code_challenge,
			expiresAt: Date.now() + AUTH_CODE_TTL_MS,
		});
		lastClientName = client.client_name ?? client.client_id;

		// Native VS Code consent: buttons ride an information message. The
		// grant resolves when the user answers; denial clears it.
		const answer = await vscode.window.showInformationMessage(
			`MCP authorization request`,
			{ modal: true, detail: `"${lastClientName}" wants to call tools in this VS Code window (files, terminal, git…).\n\nRedirect: ${redirect_uri}` },
			'Allow',
			'Deny'
		);
		const grant = grants.get(grantId);
		grants.delete(grantId);
		if (!grant || answer !== 'Allow') {
			const sep = redirect_uri.includes('?') ? '&' : '?';
			return res.redirect(302, `${redirect_uri}${sep}error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ''}`);
		}
		const code = crypto.randomBytes(24).toString('base64url');
		grant.code = code;
		grants.set(code, grant); // re-key by code for the token exchange
		const sep = redirect_uri.includes('?') ? '&' : '?';
		res.redirect(302, `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
	});

	// ---------- token exchange ----------
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
		// PKCE S256: SHA-256(verifier) base64url must equal the challenge
		const expected = crypto.createHash('sha256').update(code_verifier ?? '').digest('base64url');
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

	// ---------- revoke (best-effort no-op: tokens die with the window) ----------
	router.post('/revoke', expressUrlencoded({ extended: false }), (_req, res) => {
		res.status(200).end();
	});

	// The consent prompt reads the human name for the log/tooltip
	void lastClientName;

	return router;
}

function redirect_uris_invalid(uris: unknown[]): boolean {
	return uris.some(u => typeof u !== 'string' || !(u.startsWith('https://') || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')));
}
