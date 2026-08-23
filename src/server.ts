import express from "express";
import * as vscode from 'vscode';
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
import { logger } from './utils/logger';

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
}

export class MCPServer {
    private app: express.Application;
    private httpServer?: Server;
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;

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
            workflow: true
        };
        this.app = express();
        this.app.use(express.json());

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
            version: "0.10.0",
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

        const groups: Array<[string, boolean, () => void]> = [
            ['file', c.file, () => registerFileTools(server, fileListing)],
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
            ['workflow', c.workflow, () => registerWorkflowTools(server, terminal)]
        ];

        for (const [, enabled, register] of groups) {
            if (enabled) {
                register();
            }
        }
    }

    private setupRoutes(): void {
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
    }

    private setupEventHandlers(): void {
        // Log HTTP server events
        if (this.httpServer) {
            this.httpServer.on('error', (error: Error) => {
                logger.error(`[Server] HTTP Server Error: ${error.message}`);
            });

            this.httpServer.on('listening', () => {
                logger.info(`[Server] HTTP Server ready`);
            });

            this.httpServer.on('close', () => {
                logger.info(`[Server] HTTP Server closed`);
            });
        }
    }

    public async start(): Promise<void> {
        try {
            logger.info('[MCPServer.start] Starting MCP server');
            const startTime = Date.now();

            // Start HTTP server
            logger.info('[MCPServer.start] Starting HTTP server');
            const httpServerStartTime = Date.now();
            
            return new Promise((resolve) => {
                // Bind to localhost only for security
                this.httpServer = this.app.listen(this.port, this.host, () => {
                    const httpStartTime = Date.now() - httpServerStartTime;
                    logger.info(`[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`);
                    logger.info(`MCP Server listening on ${this.host}:${this.port}`);
                    
                    const totalTime = Date.now() - startTime;
                    logger.info(`[MCPServer.start] Server startup complete (total: ${totalTime}ms)`);
                    
                    resolve();
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
                                logger.error(`[MCPServer.stop] HTTP server closed with error: ${err.message} (took ${httpCloseTime}ms)`);
                                reject(err);
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

            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}