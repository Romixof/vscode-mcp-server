import express from "express";
import * as vscode from 'vscode';
import { generateSessionToken, readAuthConfig, bearerAuth, originGuard, tokensMatch, extractToken } from './auth';
import type { RequestHandler } from 'express';
import { createOAuthRouter } from './auth-oauth';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from 'http';
import { Request, Response } from 'express';
import { registerFileTools, FileListingCallback } from './tools/file-tools';
import { registerEditTools } from './tools/edit-tools';
import { registerShellTools } from './tools/shell-tools';
import { registerDiagnosticsTools } from './tools/diagnostics-tools';
import { registerSymbolTools } from './tools/symbol-tools';
import { registerMemoryTools } from './tools/memory-tools';
import { registerTestTools } from './tools/test-tools';
import { registerGitTools } from './tools/git-tools';
import { registerDocumentationTools } from './tools/documentation-tools';
import { registerDatabaseTools } from './tools/database-tools';
import { registerProductivityTools } from './tools/productivity-tools';
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
import { ClusterCoordinator, ClusterHost } from './cluster/coordinator';
import {
	CLUSTER_DEREGISTER_PATH,
	CLUSTER_HEARTBEAT_PATH,
	CLUSTER_HUB_SHUTDOWN_PATH,
	CLUSTER_IDENTITY_PATH,
	CLUSTER_REGISTER_PATH,
	INVOKE_PATH
} from './cluster/types';

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
    /** Access credential required on /mcp (mode-dependent). Undefined = open. */
    public authToken?: string;
    /** Set by the extension so session tokens persist in globalState. */
    public extensionContext?: vscode.ExtensionContext;
    /** OAuth endpoints, created lazily on first use in oauth mode. */
    private oauthRouterInstance?: ReturnType<typeof createOAuthRouter>;

    private get oauthRouter() {
        if (!this.oauthRouterInstance) {
            this.oauthRouterInstance = createOAuthRouter(this.port, {
                getAccessToken: () => this.authToken,
                getLastClientName: () => undefined,
            });
        }
        return this.oauthRouterInstance;
    }
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;
    // Post-zod tool callbacks of the most recent registration; the /invoke
    // endpoint dispatches through this map instead of rebuilding a session
    private invokeHandlers = new Map<string, (args: unknown, extra: unknown) => unknown>();
    // Multi-window cluster state machine; every window runs one
    public readonly cluster: ClusterCoordinator;

    public setFileListingCallback(callback: FileListingCallback) {
        this.fileListingCallback = callback;
    }

    constructor(port: number = 3000, host: string = '127.0.0.1', terminal?: vscode.Terminal, toolConfig?: ToolConfiguration) {
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
        this.app.use(express.json());

        // Cluster coordinator needs a ClusterHost; we implement it below
        this.cluster = new ClusterCoordinator(
            this as unknown as ClusterHost,
            this.port,
            this.host,
            () => vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version ?? "0.12.43"
        );
        // Spokes present the shared per-machine secret on cluster calls; both
        // windows read the same globalState so this converges naturally
        this.cluster.setClusterCredential(() => {
            const mode = readAuthConfig().mode;
            if (mode === 'none') {return undefined;}
            if (mode === 'static-token') {return readAuthConfig().staticToken;}
            return this.authToken ?? this.extensionContext?.globalState.get<string>('vscode-mcp.authToken');
        });

        this.setupRoutes();
    }

    public setupTools(): void {
        logger.info(`Setting up MCP tools with configuration: ${JSON.stringify(this.toolConfig)}`);

        if (!this.fileListingCallback) {
            logger.warn('File listing callback not set during tools setup');
            return;
        }

        // dry run so a broken tool module surfaces at startup instead of on the first request
        void this.buildSessionServer().close();
    }

    // One fresh server + tool registry per HTTP request (stateless MCP): a hung
    // tool call can no longer block or corrupt anyone else's request
    private buildSessionServer(): McpServer {
        const server = new McpServer({
            name: "vscode-mcp-server",
            version: "0.12.43",
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

        // Count calls locally (feeds get_server_info_code). The callback is
        // always the last argument of server.tool(), whatever the overload.
        const originalTool = server.tool.bind(server);
        server.tool = ((name: string, ...args: unknown[]) => {
            const last = args.length - 1;
            if (typeof args[last] === 'function') {
                const handler = args[last] as (...cbArgs: unknown[]) => unknown;
                // Store handler for /invoke dispatch; latest registration wins
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
            ['productivity', c.productivity, () => registerProductivityTools(server)],
            ['security', c.security, () => registerSecurityTools(server, terminal)],
            ['performance', c.performance, () => registerPerformanceTools(server, terminal)],
            ['refactoring', c.refactoring, () => registerRefactorTools(server)],
            ['frontend', c.frontend, () => registerFrontendTools(server)],
            ['workflow', c.workflow, () => registerWorkflowTools(server, terminal)],
            ['advanced', c.advanced, () => registerAdvancedTools(server, { host: this.host, port: this.port }, () => this.cluster.clusterInfoLine(), () => {
                const mode = readAuthConfig().mode;
                if (mode === 'none') {return 'disabled — any local process can call tools (set vscode-mcp-server.auth.mode to secure this)';}
                if (mode === 'static-token') {return 'static token — clients send Authorization: Bearer <your pinned secret> or X-MCP-Token';}
                if (mode === 'oauth') {return 'MCP OAuth 2.1 (dynamic client registration) — remote clients authenticate through the /authorize and /token endpoints';}
                return `session token — clients send Authorization: Bearer <token> or X-MCP-Token. Token for this installation: ${this.authToken}`;
            })]
        ];

        for (const [, enabled, register] of groups) {
            if (enabled) {
                register();
            }
        }

        // Not tied to any enabledTools setting: the bar stays open
        registerCoffeeTools(server);
    }

    private setupRoutes(): void {
        // --- Auth gates (Phase 12.1) ---
        // Origin first: a hostile page gets 403 before it learns anything
        // about tokens. Bearer second: no valid credential, no tool runs.
        // BOTH gates cover every route: /mcp, /invoke and the cluster
        // control plane. A public tunnel exposes all of them, so a request
        // without a credential must never reach a tool — local cluster
        // spokes authenticate with the shared session token too.
        const authCfg = () => readAuthConfig();
        this.app.use(originGuard(authCfg, this.port));
        // Credential enforcement. Public surface (no secret needed):
        //   - OAuth discovery and handshake endpoints
        //   - /__mcp_cluster/identity (read-only)
        // Everything else — /mcp, /invoke, heartbeat, deregister,
        // hub-shutdown and now REGISTER — requires the session credential.
        // A joining window reads the shared per-machine secret from
        // globalState before it registers, so legitimate spokes always
        // have it; remote attackers over the tunnel never do (F1).
        const PUBLIC_PATHS = new Set([
            '/register', '/authorize', '/token', '/revoke',
            CLUSTER_IDENTITY_PATH
        ]);
        // Cluster control plane first: state-changing routes accept the
        // X-MCP-Cluster proof from local spokes OR a full bearer; everything
        // else falls through to the plain bearer gate.
        const expectedToken = () => {
            const mode = authCfg().mode;
            if (mode === 'static-token') {return authCfg().staticToken;}
            return this.authToken;
        };
        const clusterRoutes = [CLUSTER_REGISTER_PATH, CLUSTER_HEARTBEAT_PATH, CLUSTER_DEREGISTER_PATH,
                               CLUSTER_HUB_SHUTDOWN_PATH, INVOKE_PATH];
        this.app.use((req, res, next) => {
            if (authCfg().mode === 'none') {return next();}
            if (req.path.startsWith('/.well-known/') || PUBLIC_PATHS.has(req.path)) {return next();}
            if (clusterRoutes.includes(req.path)) {
                const expected = expectedToken();
                if (!expected) {return next();}
                const presented = req.headers['x-mcp-cluster'];
                if (typeof presented === 'string' && presented && tokensMatch(presented, expected)) {
                    return next();
                }
                const bearer = extractToken(req.headers as Record<string, string | string[] | undefined>);
                if (bearer && tokensMatch(bearer, expected)) {return next();}
                res.setHeader('WWW-Authenticate', 'Bearer realm="vscode-mcp-server"');
                return res.status(401).json({ error: 'invalid_token', error_description: 'cluster control plane requires the session credential (X-MCP-Cluster or Authorization: Bearer)' });
            }
            bearerAuth(expectedToken)(req, res, next);
        });
        // OAuth endpoints mount before the bearer gate so discovery,
        // registration, authorize and token stay reachable pre-auth (per spec)
        this.app.use((req, res, next) => {
            if (authCfg().mode === 'oauth') {
                return this.oauthRouter(req, res, next);
            }
            next();
        });

        // Stateless mode, one session per request: every POST gets its own
        // transport and tool registry, disposed once the response is out. The
        // old shared transport serialized everything, so a single hung tool
        // call starved every later request until clients went "Not connected".
        this.app.post('/mcp', async (req, res) => {
            logger.info(`Request received: ${req.method} ${req.url}`);
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
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true
                });
                sessionServer = this.buildSessionServer();
                res.on('close', dispose);
                await sessionServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
                dispose();
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

        // Unsupported methods get a bare 405 per the MCP spec — a JSON-RPC error
        // body here is what clients surface as "-32000 Connection closed"
        const methodNotAllowed: express.RequestHandler = (req, res) => {
            logger.info(`Received ${req.method} MCP request`);
            res.setHeader('Allow', 'POST');
            res.status(405).end();
        };

        this.app.get('/mcp', methodNotAllowed);
        this.app.get('/mcp/sse', methodNotAllowed);
        this.app.delete('/mcp', methodNotAllowed);

        // Handle OPTIONS requests for CORS
        this.app.options('/mcp', (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
            res.status(204).end();
        });

        // --- Cluster control plane ---
        // Identity endpoint: tells joining windows this is a hub they can join
        this.app.get(CLUSTER_IDENTITY_PATH, (req, res) => {
            res.json(this.cluster.handleIdentity());
        });

        // Registration endpoint: spokes POST their folders to the hub
        this.app.post(CLUSTER_REGISTER_PATH, express.json(), (req, res) => {
            const result = this.cluster.handleRegister(req.body);
            res.status(result.status).json(result.body);
        });

        // Heartbeat endpoint: spokes refresh their lease
        this.app.post(CLUSTER_HEARTBEAT_PATH, express.json(), (req, res) => {
            const result = this.cluster.handleHeartbeat(req.body.windowId, req.body.port, req.body.folders);
            res.status(result.status).json(result.body);
        });

        // Deregister endpoint: spoke says goodbye
        this.app.post(CLUSTER_DEREGISTER_PATH, express.json(), (req, res) => {
            this.cluster.handleDeregister(req.body.windowId);
            res.json({ ok: true });
        });

        // Hub shutdown broadcast: hub tells spokes to start election
        this.app.post(CLUSTER_HUB_SHUTDOWN_PATH, (req, res) => {
            this.cluster.handleHubShutdown();
            res.json({ ok: true });
        });

        // Invocation endpoint: hub forwards tool calls to spokes
        this.app.post(INVOKE_PATH, express.json(), async (req, res) => {
            const result = await this.cluster.handleInvoke(req.body);
            res.status(result.status).json(result.body);
        });

        // F11 — last-resort error handler. Without this, Express answers an
        // unexpected throw with an HTML page carrying the full stack trace
        // (absolute install paths included) to whoever triggered it.
        this.app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            const message = err instanceof Error ? err.message : 'Internal error';
            logger.error(`[http] Unhandled error on ${_req.method} ${_req.path}: ${message}`);
            if (res.headersSent) return;
            res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
        });
    }

    // --- ClusterHost implementation ---

    /** Binds the shared express app; rejects with the underlying error (code EADDRINUSE et al). */
    async listenOn(port: number, host: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = this.app.listen(port, host, () => {
                const addr = server.address();
                const boundPort = typeof addr === 'object' && addr ? addr.port : port;
                // Remember the socket so stop()/closeListener() can reach it:
                // a spoke's ephemeral listener is bound here, never in start()
                this.httpServer = server;
                logger.info(`[ClusterHost.listenOn] Bound to ${host}:${boundPort}`);
                resolve(boundPort);
            });
            server.once('error', (error: Error & { code?: string }) => {
                reject(error);
            });
        });
    }

    /** Closes whichever listener currently holds the app. */
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

    /** Executes a registered tool handler directly (post-zod), bypassing routing. */
    async invokeLocally(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const handler = this.invokeHandlers.get(tool);
        if (!handler) {
            throw new Error(`Tool ${tool} not registered`);
        }
        return handler(args, {});
    }

    /** True when this window registered the tool (enabledTools differ per window). */
    hasTool(tool: string): boolean {
        // Registrations happen during setupTools(); before that nothing is
        // served, which is exactly what the caller needs to know
        return this.invokeHandlers.has(tool);
    }

    public async start(): Promise<void> {
        try {
            logger.info('[MCPServer.start] Starting MCP server');
            const startTime = Date.now();

            // Session-token mode: create once, persist across window reloads.
            // OAuth mode also needs the secret — issued tokens ARE this value.
            const authMode = readAuthConfig().mode;
            if (authMode === 'session-token' || authMode === 'oauth') {
                if (!this.authToken) {
                    this.authToken = this.extensionContext?.globalState.get<string>('vscode-mcp.authToken')
                        || generateSessionToken();
                    void this.extensionContext?.globalState.update('vscode-mcp.authToken', this.authToken);
                }
                logger.info('[MCPServer.start] Access token ready (shown once at activation; available via get_server_info_code and the copy command)');
            } else if (authMode === 'static-token') {
                this.authToken = readAuthConfig().staticToken;
            } else {
                this.authToken = undefined;
            }

            // Start HTTP server
            logger.info('[MCPServer.start] Starting HTTP server');
            const httpServerStartTime = Date.now();

            return new Promise((resolve, reject) => {
                // Bind to localhost only for security
                this.httpServer = this.app.listen(this.port, this.host, () => {
                    const httpStartTime = Date.now() - httpServerStartTime;
                    logger.info(`[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`);
                    logger.info(`MCP Server listening on ${this.host}:${this.port}`);

                    const totalTime = Date.now() - startTime;
                    logger.info(`[MCPServer.start] Server startup complete (total: ${totalTime}ms)`);

                    resolve();
                });
                // A taken port surfaces as an 'error' event, not an exception:
                // without this listener the startup promise never settles and
                // the window sits half-started with no explanation
                this.httpServer.once('error', async (error: Error & { code?: string }) => {
                    const detail = error.code === 'EADDRINUSE'
                        ? `port ${this.port} is already in use — another VS Code window may already be serving MCP there; give this window its own vscode-mcp-server.port`
                        : error.message;
                    logger.error(`[MCPServer.start] HTTP Server failed to listen: ${detail}`);
                    if (error.code === 'EADDRINUSE') {
                        try {
                            // On success this swapped this.httpServer to the
                            // spoke's ephemeral listener via listenOn()
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
            // Close HTTP server with timeout
            if (this.httpServer) {
                logger.info('[MCPServer.stop] Closing HTTP server (with timeout)');
                const httpServerCloseStart = Date.now();

                await Promise.race([
                    // Normal close operation
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

                    // Timeout fallback
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            logger.warn(`[MCPServer.stop] HTTP server close timed out after ${forceTimeout}ms - forcing close`);
                            // We resolve anyway to continue with the shutdown process
                            resolve();
                        }, forceTimeout);
                    })
                ]);
            }

            // Per-request sessions tear themselves down through their own
            // res 'close' handlers as the sockets die with the server

            // Cluster goodbye (deregister / hub-shutdown fan-out) runs after
            // the listener is down so a spoke that promotes instantly never
            // races our still-open port
            await this.cluster.stop();

            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}