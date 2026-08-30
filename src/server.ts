import express from "express";
import * as vscode from 'vscode';
import { generateSessionToken, readAuthConfig, bearerAuth, originGuard, tokensMatch, extractToken, verifyApiKeyAsync, setSecretStorage, generateAndStoreApiKey, getStoredApiKey } from './auth';
import type { RequestHandler } from 'express';
import { createOAuthRouter } from './auth-oauth';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from 'http';
import { Request, Response } from 'express';
import { registerFileTools, FileListingCallback } from './tools/file-tools';
import { registerEditTools } from './tools/edit-tools';
import { registerShellTools } from './tools/shell-tools';
import { Dashboard, estimateTokens } from './dashboard';
import { registerDiagnosticsTools } from './tools/diagnostics-tools';
import { registerSymbolTools } from './tools/symbol-tools';
import { registerMemoryTools } from './tools/memory-tools';
import { registerTestTools } from './tools/test-tools';
import { registerGitTools } from './tools/git-tools';
import { registerDocumentationTools } from './tools/documentation-tools';
import { registerDatabaseTools } from './tools/database-tools';
import { registerProductivityTools } from './tools/productivity-tools';
import { registerCalendarTools } from './tools/calendar-tools';
import { registerSecurityTools } from './tools/security-tools';
import { registerPerformanceTools } from './tools/performance-tools';
import { registerRefactorTools } from './tools/refactor-tools';
import { registerFrontendTools } from './tools/frontend-tools';
import { registerWorkflowTools } from './tools/workflow-tools';
import { registerAdvancedTools } from './tools/advanced-tools';
import { registerCoffeeTools } from './tools/coffee-tools';
import { EXTENSION_ID } from './tools/advanced-tools';
import { recordToolCall } from './utils/usage';
import { logger } from './utils/logger';
import { setClusterRootsProvider } from './utils/workspace';
import type { Scope } from './auth/scopes';
import { runWithScopes, checkToolAccess, currentScopes } from './auth/toolgate';
import { ALL_SCOPES as LOCAL_ALL_SCOPES, scopeAllows as scopeAllowsCached } from './auth/scopes';
import { appendAudit } from './auth/audit';
import { checkShellCommand } from './auth/shellguard';
import { ClusterCoordinator, ClusterHost } from './cluster/coordinator';
import {
	CLUSTER_DEREGISTER_PATH,
	CLUSTER_HEARTBEAT_PATH,
	CLUSTER_HUB_SHUTDOWN_PATH,
	CLUSTER_IDENTITY_PATH,
	CLUSTER_REGISTER_PATH,
	INVOKE_PATH
} from './cluster/types';

let api_key_cache: string | undefined;
export async function refreshApiKeyCache(): Promise<void> {
	if (readAuthConfig().mode === 'api-key') {
		api_key_cache = await getStoredApiKey();
	}
}

export interface ToolConfiguration {
    file: boolean;
    edit: boolean;
    shell: boolean;
    diagnostics: boolean;
    symbol: boolean;
    memory: boolean;
    test: boolean;
    git: boolean;
    documentation: boolean;
    database: boolean;
    productivity: boolean;
    security: boolean;
    performance: boolean;
    refactoring: boolean;
    frontend: boolean;
    workflow: boolean;
    advanced: boolean;
}

export class MCPServer {
    private app: express.Application;
    private httpServer?: Server;

    public authToken?: string;

    public extensionContext?: vscode.ExtensionContext;

    private oauthRouterInstance?: ReturnType<typeof createOAuthRouter>;
    private dashboard?: Dashboard;

    private get oauthRouter() {
        if (!this.oauthRouterInstance) {
            this.oauthRouterInstance = createOAuthRouter(this.port, {
                getAccessToken: () => this.authToken ?? this.extensionContext?.globalState.get<string>('vscode-mcp.authToken'),
                getAlternateSecret: () => {
                    const stored = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                    if (stored && stored !== this.authToken) return stored;
                    return undefined;
                },
                getAllSecrets: () => {
                    const out = new Set<string>();
                    const cur = this.authToken ?? this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                    if (cur && typeof cur === 'string' && cur.length >= 16) out.add(cur);
                    const stored = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                    if (stored && typeof stored === 'string' && stored.length >= 16) out.add(stored);
                    try {
                        const hist = this.extensionContext?.globalState.get<string[]>('vscode-mcp.authTokenHistory') ?? [];
                        for (const h of Array.isArray(hist) ? hist : []) if (typeof h === 'string' && h.length >= 16) out.add(h);
                    } catch {}
                    return [...out];
                },
                getLastClientName: () => undefined,
                loadClients: () => {
                    const raw = this.extensionContext?.globalState.get<Array<{ client_id: string; redirect_uris: string[]; client_name?: string; requestedScopes?: string; grantedScopes?: string[] }>>('vscode-mcp.oauthClients');
                    return Array.isArray(raw)
                        ? raw.filter(c => typeof c?.client_id === 'string' && Array.isArray(c.redirect_uris))
                              .map(c => ({ client_id: c.client_id, redirect_uris: c.redirect_uris, client_name: c.client_name, requestedScopes: c.requestedScopes, grantedScopes: c.grantedScopes as unknown as import('./auth/scopes').Scope[] }))
                        : [];
                },
                saveClients: list => {
                    try {
                        const raw = this.extensionContext?.globalState.get<Array<{ client_id: string; redirect_uris: string[]; client_name?: string; requestedScopes?: string; grantedScopes?: string[] }>>('vscode-mcp.oauthClients');
                        const merged = new Map<string, { client_id: string; redirect_uris: string[]; client_name?: string; requestedScopes?: string; grantedScopes?: string[] }>();
                        for (const c of Array.isArray(raw) ? raw : []) {
                            if (typeof c?.client_id === 'string') merged.set(c.client_id, c);
                        }
                        for (const c of list as unknown as Array<{ client_id: string; redirect_uris: string[]; client_name?: string; requestedScopes?: string; grantedScopes?: string[] }>) {
                            const ex = merged.get(c.client_id);
                            if (ex && Array.isArray(ex.grantedScopes) && ex.grantedScopes.length && (!c.grantedScopes || !c.grantedScopes.length)) {
                                (c as unknown as { grantedScopes: string[] }).grantedScopes = ex.grantedScopes;
                            }
                            merged.set(c.client_id, c as unknown as { client_id: string; redirect_uris: string[]; client_name?: string; requestedScopes?: string; grantedScopes?: string[] });
                        }
                        void this.extensionContext?.globalState.update('vscode-mcp.oauthClients', [...merged.values()]);
                    } catch {
                        void this.extensionContext?.globalState.update('vscode-mcp.oauthClients', list);
                    }
                },
            });
        }
        return this.oauthRouterInstance;
    }
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;

    private invokeHandlers = new Map<string, (args: unknown, extra: unknown) => unknown>();

    public readonly cluster: ClusterCoordinator;

    public setFileListingCallback(callback: FileListingCallback) {
        this.fileListingCallback = callback;
    }

    constructor(port: number = 3400, host: string = '127.0.0.1', terminal?: vscode.Terminal, toolConfig?: ToolConfiguration) {
        this.port = port;
        this.host = host;
        this.terminal = terminal;
        this.toolConfig = toolConfig || {
            file: true,
            edit: true,
            shell: true,
            diagnostics: true,
            symbol: true,
            memory: true,
            test: true,
            git: true,
            documentation: true,
            database: true,
            productivity: true,
            security: true,
            performance: true,
            refactoring: true,
            frontend: true,
            workflow: true,
            advanced: true
        };
        this.app = express();

        this.cluster = new ClusterCoordinator(
            this as unknown as ClusterHost,
            this.port,
            this.host,
            () => vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version ?? "0.15.1"
        );

        this.cluster.setClusterCredential(() => {
            const mode = readAuthConfig().mode;
            if (mode === 'none') {return undefined;}
            if (mode === 'static-token') {return readAuthConfig().staticToken;}
            if (mode === 'api-key') {return api_key_cache;}
            return this.authToken ?? this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
        });

        setClusterRootsProvider(() => this.cluster.clusterTrustedFolderPaths());

        this.setupRoutes();
    }

    public setupTools(): void {
        logger.info(`Setting up MCP tools with configuration: ${JSON.stringify(this.toolConfig)}`);

        if (!this.fileListingCallback) {
            logger.warn('File listing callback not set during tools setup');
            return;
        }

        void this.buildSessionServer().close();
    }

    private buildSessionServer(): McpServer {
        const server = new McpServer({
            name: "vscode-mcp-server",
            version: "0.15.1",
        }, {
            capabilities: {
                logging: {},
                tools: {
                    listChanged: false
                }
            }
        });
        this.registerToolsOn(server);
        return server;
    }

    private registerToolsOn(server: McpServer): void {
        const fileListing = this.fileListingCallback;
        const terminal = this.terminal;
        const c = this.toolConfig;

        if (!fileListing) {
            throw new Error('File listing callback not set');
        }

        const originalTool = server.tool.bind(server);
        server.tool = ((name: string, ...args: unknown[]) => {
            const last = args.length - 1;
            if (typeof args[last] === 'function') {
                const handler = args[last] as (...cbArgs: unknown[]) => unknown;

                this.invokeHandlers.set(name, handler);
                args[last] = (...cbArgs: unknown[]) => {
                    recordToolCall(name);
                    const decision = this.cluster.resolveRoute(name, cbArgs[0] as Record<string, unknown>);
                    if (decision.kind === 'local') {
                        if (decision.args) {
                            cbArgs[0] = decision.args;
                        }
                        return handler(...cbArgs);
                    }
                    return this.cluster.dispatchRoute(name, decision, cbArgs, handler);
                };
            }
            return (originalTool as (...toolArgs: unknown[]) => unknown)(name, ...args);
        }) as typeof server.tool;

        const groups: Array<[string, boolean, () => void]> = [
            ['file', c.file, () => registerFileTools(server, fileListing, () => this.cluster.clusterFolderListing())],
            ['edit', c.edit, () => registerEditTools(server)],
            ['shell', c.shell, () => registerShellTools(server, terminal)],
            ['diagnostics', c.diagnostics, () => registerDiagnosticsTools(server)],
            ['symbol', c.symbol, () => registerSymbolTools(server)],
            ['memory', c.memory, () => registerMemoryTools(server)],
            ['test', c.test, () => registerTestTools(server)],
            ['git', c.git, () => registerGitTools(server)],
            ['documentation', c.documentation, () => registerDocumentationTools(server)],
            ['database', c.database, () => registerDatabaseTools(server, terminal)],
            ['productivity', c.productivity, () => {
                registerProductivityTools(server);
                registerCalendarTools(server);
            }],
            ['security', c.security, () => registerSecurityTools(server, terminal)],
            ['performance', c.performance, () => registerPerformanceTools(server, terminal)],
            ['refactoring', c.refactoring, () => registerRefactorTools(server)],
            ['frontend', c.frontend, () => registerFrontendTools(server)],
            ['workflow', c.workflow, () => registerWorkflowTools(server, terminal)],
            ['advanced', c.advanced, () => registerAdvancedTools(server, { host: this.host, port: this.port }, () => this.cluster.clusterInfoLine(), () => {
                const mode = readAuthConfig().mode;
                if (mode === 'none') {return 'disabled — any local process can call tools (set vscode-mcp-server.auth.mode to secure this)';}
                if (mode === 'static-token') {return 'static token — clients send Authorization: Bearer <token> or X-MCP-Token';}
                if (mode === 'oauth') {return 'MCP OAuth 2.1 (dynamic client registration) — remote clients authenticate through the /authorize and /token endpoints';}
                if (mode === 'api-key') {return 'api key — clients send Authorization: Bearer <key>. Key is auto-generated and stored in VS Code SecretStorage on first activation';}
                return `session token — clients send Authorization: Bearer <token> or X-MCP-Token. Token for this installation: ${this.authToken}`;
            })]
        ];

        for (const [, enabled, register] of groups) {
            if (enabled) {
                register();
            }
        }

        registerCoffeeTools(server);
        this.enforceScopesOn(server);
    }

    /**
     * F-SCOPE — wraps every registered tool handler with a scope check.
     * Runs inside the AsyncLocalStorage context established by the auth
     * middleware, so the granted scopes travel with the request.
     */
    private enforceScopesOn(server: McpServer): void {
        const registrations = (server as unknown as { _registeredTools?: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
        if (!registrations) {
            return;
        }
        for (const name of Object.keys(registrations)) {
            const entry = registrations[name];
            const original = entry.handler.bind(entry);
            entry.handler = async (args: unknown, extra: unknown) => {
                const { scopes, client } = currentScopes();
                logger.info(`Tool called: ${name} by client: ${client}`);
                const started = Date.now();
                if (!scopeAllowsCached(scopes, name)) {
                    this.dashboard?.recordToolCall(name, client, 0, 0, true);
                    return checkToolAccess(name, scopes, client) as unknown as ReturnType<typeof original>;
                }
                appendAudit({ kind: 'tool_call', client, detail: name });
                try {
                    const result = await original(args, extra);
                    this.dashboard?.recordToolCall(name, client, Date.now() - started, estimateTokens(result), false);
                    return result;
                } catch (e) {
                    this.dashboard?.recordToolCall(name, client, Date.now() - started, 0, false);
                    throw e;
                }
            };
        }
    }

    attachDashboard(d: Dashboard): void { this.dashboard = d; }

    private setupRoutes(): void {

        const authCfg = () => readAuthConfig();
        this.app.use(originGuard(authCfg, this.port));

        const PUBLIC_PATHS = new Set([
            '/register', '/authorize', '/token', '/revoke',
            CLUSTER_IDENTITY_PATH
        ]);
        const expectedToken = (): string | undefined => {
            const mode = authCfg().mode;
            if (mode === 'static-token') {return authCfg().staticToken;}
            if (mode === 'api-key') {return api_key_cache;}
            return this.authToken;
        };
        const clusterRoutes = [CLUSTER_REGISTER_PATH, CLUSTER_HEARTBEAT_PATH, CLUSTER_DEREGISTER_PATH,
                               CLUSTER_HUB_SHUTDOWN_PATH, INVOKE_PATH];
        this.app.use(async (req, res, next) => {
            if (authCfg().mode === 'none') {return next();}
            if (authCfg().mode === 'api-key') {
                const valid = await verifyApiKeyAsync(req, authCfg());
                if (valid) {return runWithScopes(LOCAL_ALL_SCOPES, 'api-key-client', next);}
                res.setHeader('WWW-Authenticate', 'Bearer realm="vscode-mcp-server", error="invalid_token"');
                return res.status(401).json({ error: 'invalid_token' });
            }
            if (req.path.startsWith('/.well-known/') || PUBLIC_PATHS.has(req.path)) {return next();}
            const presented = extractToken(req.headers as Record<string, string | string[] | undefined>);

            if (presented && (authCfg().mode === 'oauth') && this.oauthRouterInstance) {
                const verdict = (this.oauthRouterInstance as unknown as { verifyDerivedToken(t: string): { verdict: 'ok' | 'revoked' | 'unknown'; scopes: Scope[]; client?: string } }).verifyDerivedToken(presented);
                if (verdict.verdict === 'ok') {
                    runWithScopes(verdict.scopes, verdict.client ?? 'oauth-client', next);
                    return;
                }
                if (verdict.verdict === 'revoked') {
                    res.setHeader('WWW-Authenticate', 'Bearer realm="vscode-mcp-server", error="invalid_token"');
                    return res.status(401).json({ error: 'invalid_token', error_description: 'token revoked' });
                }
            }
            if (clusterRoutes.includes(req.path)) {
                const expected = expectedToken();
                if (!expected) {return next();}
                const clusterHdr = req.headers['x-mcp-cluster'];
                if (typeof clusterHdr === 'string' && clusterHdr && tokensMatch(clusterHdr, expected)) {return next();}
                if (presented && tokensMatch(presented, expected)) {return next();}
                res.setHeader('WWW-Authenticate', 'Bearer realm="vscode-mcp-server"');
                return res.status(401).json({ error: 'invalid_token' });
            }
            bearerAuth(expectedToken)(req, res, () => runWithScopes(LOCAL_ALL_SCOPES, 'local-session', next));
        });

        this.app.use((req, res, next) => {
            if (authCfg().mode === 'oauth') {
                return this.oauthRouter(req, res, next);
            }
            next();
        });

        this.app.post('/mcp', express.json(), async (req, res) => {
            const clientName = (req.headers['x-mcp-client-name'] as string) || 'unknown';
            logger.info(`MCP request from ${clientName}`);
            let transport: StreamableHTTPServerTransport | undefined;
            let sessionServer: McpServer | undefined;
            let disposed = false;
            const dispose = () => {
                if (disposed || !transport || !sessionServer) {
                    return;
                }
                disposed = true;
                void transport.close();
                void sessionServer.close();
            };

            try {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                // Ensure accept header is present for MCP protocol negotiation
                if (!req.headers['accept'] || req.headers['accept'] === '*/*') {
                    req.headers['accept'] = 'application/json, text/event-stream';
                }
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true
                });
                sessionServer = this.buildSessionServer();
                res.on('close', dispose);
                await sessionServer.connect(transport);
                await transport.handleRequest(req, res, typeof req.body === 'object' && req.body !== null ? req.body : {});
            } catch (error) {
                logger.error(`Error handling MCP request: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
                dispose();
            }
        });

        const methodNotAllowed: express.RequestHandler = (req, res) => {
            logger.info(`Received ${req.method} MCP request`);
            res.setHeader('Allow', 'POST');
            res.status(405).end();
        };

        this.app.get('/mcp', methodNotAllowed);
        this.app.get('/mcp/sse', methodNotAllowed);
        this.app.delete('/mcp', methodNotAllowed);

        this.app.options('/mcp', (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
            res.status(204).end();
        });

        this.app.get(CLUSTER_IDENTITY_PATH, (req, res) => {
            res.json(this.cluster.handleIdentity());
        });

        this.app.post(CLUSTER_REGISTER_PATH, express.json(), (req, res) => {
            const result = this.cluster.handleRegister(req.body);
            res.status(result.status).json(result.body);
        });

        this.app.post(CLUSTER_HEARTBEAT_PATH, express.json(), (req, res) => {
            const result = this.cluster.handleHeartbeat(req.body.windowId, req.body.port, req.body.folders);
            res.status(result.status).json(result.body);
        });

        this.app.post(CLUSTER_DEREGISTER_PATH, express.json(), (req, res) => {
            this.cluster.handleDeregister(req.body.windowId);
            res.json({ ok: true });
        });

        this.app.post(CLUSTER_HUB_SHUTDOWN_PATH, (req, res) => {
            this.cluster.handleHubShutdown();
            res.json({ ok: true });
        });

        this.app.post(INVOKE_PATH, express.json(), async (req, res) => {
            const result = await this.cluster.handleInvoke(req.body);
            res.status(result.status).json(result.body);
        });

        this.app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            const message = err instanceof Error ? err.message : 'Internal error';
            logger.error(`[http] Unhandled error on ${_req.method} ${_req.path}: ${message}`);
            if (res.headersSent) {return;}
            res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
        });
    }

    async listenOn(port: number, host: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = this.app.listen(port, host, () => {
                const addr = server.address();
                const boundPort = typeof addr === 'object' && addr ? addr.port : port;

                this.httpServer = server;
                logger.info(`[ClusterHost.listenOn] Bound to ${host}:${boundPort}`);
                resolve(boundPort);
            });
            server.once('error', (error: Error & { code?: string }) => {
                reject(error);
            });
        });
    }

    async closeListener(): Promise<void> {
        if (this.httpServer) {
            const server = this.httpServer;
            this.httpServer = undefined;
            await new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }
    }

    async invokeLocally(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const handler = this.invokeHandlers.get(tool);
        if (!handler) {
            throw new Error(`Tool ${tool} not registered`);
        }
        return handler(args, {});
    }

    hasTool(tool: string): boolean {

        return this.invokeHandlers.has(tool);
    }

    public async start(): Promise<void> {
        try {
            logger.info('[MCPServer.start] Starting MCP server');
            const startTime = Date.now();

            const authMode = readAuthConfig().mode;
            if (authMode === 'session-token' || authMode === 'oauth') {
                if (!this.authToken) {
                    const stored = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                    if (stored && typeof stored === 'string' && stored.length >= 16) {
                        this.authToken = stored;
                    } else {
                        const recheck = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                        if (recheck && typeof recheck === 'string' && recheck.length >= 16) {
                            this.authToken = recheck;
                        } else {
                            const fresh = generateSessionToken();
                            this.authToken = fresh;
                            void this.extensionContext?.globalState.update('vscode-mcp.authToken', fresh);
                            try {
                                const hist0 = this.extensionContext?.globalState.get<string[]>('vscode-mcp.authTokenHistory') ?? [];
                                if (!Array.isArray(hist0) || hist0.length === 0) {
                                    void this.extensionContext?.globalState.update('vscode-mcp.authTokenHistory', [fresh]);
                                }
                            } catch {}
                            setTimeout(() => {
                                try {
                                    const after = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                                    if (after && after !== this.authToken) {
                                        try {
                                            const hist = this.extensionContext?.globalState.get<string[]>('vscode-mcp.authTokenHistory') ?? [];
                                            const arr = Array.isArray(hist) ? hist.slice() : [];
                                            if (this.authToken && !arr.includes(this.authToken)) arr.unshift(this.authToken);
                                            if (after && !arr.includes(after)) arr.unshift(after);
                                            while (arr.length > 3) arr.pop();
                                            void this.extensionContext?.globalState.update('vscode-mcp.authTokenHistory', arr);
                                        } catch {}
                                        this.authToken = after;
                                    }
                                } catch {}
                            }, 700);
                        }
                    }
                } else {
                    try {
                        const stored = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
                        if (stored && stored !== this.authToken && typeof stored === 'string' && stored.length >= 16) {
                            logger.info('[MCPServer] Reconciling auth token with stored value');
                            try {
                                const hist = this.extensionContext?.globalState.get<string[]>('vscode-mcp.authTokenHistory') ?? [];
                                const arr = Array.isArray(hist) ? hist.slice() : [];
                                if (this.authToken && !arr.includes(this.authToken)) arr.unshift(this.authToken);
                                while (arr.length > 3) arr.pop();
                                void this.extensionContext?.globalState.update('vscode-mcp.authTokenHistory', arr);
                            } catch {}
                            this.authToken = stored;
                        }
                    } catch {}
                }
                logger.info('[MCPServer.start] Access token ready (shown once at activation; available via get_server_info_code and the copy command)');
            } else if (authMode === 'static-token') {
                this.authToken = readAuthConfig().staticToken;
            } else if (authMode === 'api-key') {
                await refreshApiKeyCache();
            }

            logger.info('[MCPServer.start] Starting HTTP server');
            const httpServerStartTime = Date.now();

            return new Promise((resolve, reject) => {

                this.httpServer = this.app.listen(this.port, this.host, () => {
                    const httpStartTime = Date.now() - httpServerStartTime;
                    logger.info(`[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`);
                    logger.info(`MCP Server listening on ${this.host}:${this.port}`);

                    const totalTime = Date.now() - startTime;
                    logger.info(`[MCPServer.start] Server startup complete (total: ${totalTime}ms)`);
                    logger.info('MCP Server started successfully');
                    resolve();
                });

                this.httpServer.once('error', async (error: Error & { code?: string }) => {
                    const detail = error.code === 'EADDRINUSE'
                        ? `port ${this.port} is already in use — another VS Code window may already be serving MCP there; give this window its own vscode-mcp-server.port`
                        : error.message;
                    logger.error(`[MCPServer.start] HTTP Server failed to listen: ${detail}`);
                    if (error.code === 'EADDRINUSE') {
                        try {
                            await this.cluster.joinAfterAddressInUse(error);
                            logger.info('[MCPServer.start] Successfully joined as spoke');
                            resolve();
                            return;
                        } catch (joinError) {
                            logger.error(`[MCPServer.start] Failed to join cluster: ${joinError instanceof Error ? joinError.message : String(joinError)}`);
                            reject(joinError);
                            return;
                        }
                    }
                    reject(new Error(detail));
                });
            });
        } catch (error) {
            logger.error(`[MCPServer.start] Failed to start MCP Server: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    public async stop(forceTimeout: number = 5000): Promise<void> {
        logger.info('[MCPServer.stop] Starting server shutdown process');
        const stopStartTime = Date.now();

        try {

            if (this.httpServer) {
                logger.info('[MCPServer.stop] Closing HTTP server (with timeout)');
                const httpServerCloseStart = Date.now();

                await Promise.race([

                    new Promise<void>((resolve, reject) => {
                        this.httpServer!.close((err) => {
                            const httpCloseTime = Date.now() - httpServerCloseStart;
                            if (err) {
                                logger.warn(`[MCPServer.stop] HTTP server closed with error: ${err.message} (took ${httpCloseTime}ms)`);
                                resolve();
                            } else {
                                logger.info(`[MCPServer.stop] HTTP server closed successfully (took ${httpCloseTime}ms)`);
                                resolve();
                            }
                        });
                    }),

                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            logger.warn(`[MCPServer.stop] HTTP server close timed out after ${forceTimeout}ms - forcing close`);
                            resolve();
                        }, forceTimeout);
                    })
                ]);
            }

            await this.cluster.stop();

            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}
