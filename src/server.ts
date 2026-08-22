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
}

export class MCPServer {
    private server: McpServer;
    private transport: StreamableHTTPServerTransport;
    private app: express.Application;
    private httpServer?: Server;
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;
    private mcpQueue: Promise<unknown> = Promise.resolve();

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
            productivity: true
        };
        this.app = express();
        this.app.use(express.json());

        // Initialize MCP Server
        this.server = new McpServer({
            name: "vscode-mcp-server",
            version: "0.8.0",
        }, {
            capabilities: {
                logging: {},
                tools: {
                    listChanged: false
                }
            }
        });

        // Initialize transport
        this.transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        // Note: setupTools() is no longer called here
        this.setupRoutes();
        this.setupEventHandlers();
    }
    
    public setupTools(): void {
        // Register tools from the tools module based on configuration
        if (this.fileListingCallback) {
            logger.info(`Setting up MCP tools with configuration: ${JSON.stringify(this.toolConfig)}`);
            
            // Register file tools if enabled
            if (this.toolConfig.file) {
                registerFileTools(this.server, this.fileListingCallback);
                logger.info('MCP file tools registered successfully');
            } else {
                logger.info('MCP file tools disabled by configuration');
            }
            
            // Register edit tools if enabled
            if (this.toolConfig.edit) {
                registerEditTools(this.server);
                logger.info('MCP edit tools registered successfully');
            } else {
                logger.info('MCP edit tools disabled by configuration');
            }
            
            // Register shell tools if enabled
            if (this.toolConfig.shell) {
                registerShellTools(this.server, this.terminal);
                logger.info('MCP shell tools registered successfully');
            } else {
                logger.info('MCP shell tools disabled by configuration');
            }
            
            // Register diagnostics tools if enabled
            if (this.toolConfig.diagnostics) {
                registerDiagnosticsTools(this.server);
                logger.info('MCP diagnostics tools registered successfully');
            } else {
                logger.info('MCP diagnostics tools disabled by configuration');
            }
            
            // Register symbol tools if enabled
            if (this.toolConfig.symbol) {
                registerSymbolTools(this.server);
                logger.info('MCP symbol tools registered successfully');
            } else {
                logger.info('MCP symbol tools disabled by configuration');
            }

            // Register memory tools if enabled
            if (this.toolConfig.memory) {
                registerMemoryTools(this.server);
                logger.info('MCP memory tools registered successfully');
            } else {
                logger.info('MCP memory tools disabled by configuration');
            }

            // Register test tools if enabled
            if (this.toolConfig.test) {
                registerTestTools(this.server);
                logger.info('MCP test tools registered successfully');
            } else {
                logger.info('MCP test tools disabled by configuration');
            }

            // Register git tools if enabled
            if (this.toolConfig.git) {
                registerGitTools(this.server);
                logger.info('MCP git tools registered successfully');
            } else {
                logger.info('MCP git tools disabled by configuration');
            }

            // Register documentation tools if enabled
            if (this.toolConfig.documentation) {
                registerDocumentationTools(this.server);
                logger.info('MCP documentation tools registered successfully');
            } else {
                logger.info('MCP documentation tools disabled by configuration');
            }

            // Register database tools if enabled
            if (this.toolConfig.database) {
                registerDatabaseTools(this.server, this.terminal);
                logger.info('MCP database tools registered successfully');
            } else {
                logger.info('MCP database tools disabled by configuration');
            }

            // Register productivity tools if enabled
            if (this.toolConfig.productivity) {
                registerProductivityTools(this.server);
                logger.info('MCP productivity tools registered successfully');
            } else {
                logger.info('MCP productivity tools disabled by configuration');
            }
        } else {
            logger.warn('File listing callback not set during tools setup');
        }
    }

    private setupRoutes(): void {
        // The shared stateless transport handles one request at a time; requests
        // arriving concurrently are queued so an overlapping retry can't corrupt it
        this.mcpQueue = Promise.resolve();

        // Handle POST requests for client-to-server communication
        this.app.post('/mcp', async (req, res) => {
            logger.info(`Request received: ${req.method} ${req.url}`);
            const task = this.mcpQueue.then(() => this.transport.handleRequest(req, res, req.body));
            this.mcpQueue = task.catch(() => undefined);
            try {
                await task;
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
            }
        });

        // Handle SSE endpoint for server-to-client streaming
        this.app.get('/mcp/sse', async (req, res) => {
            logger.info('Received SSE connection request');
            try {
                await this.transport.handleRequest(req, res, undefined);
            } catch (error) {
                logger.error(`Error handling SSE request: ${error instanceof Error ? error.message : String(error)}`);
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
            }
        });

        // Unsupported methods get a bare 405 per the MCP spec — a JSON-RPC error
        // body here is what clients surface as "-32000 Connection closed"
        this.app.get('/mcp', (_req, res) => {
            logger.info('Received GET MCP request');
            res.setHeader('Allow', 'POST');
            res.status(405).end();
        });

        this.app.delete('/mcp', (_req, res) => {
            logger.info('Received DELETE MCP request');
            res.setHeader('Allow', 'POST');
            res.status(405).end();
        });

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

            // Connect transport before starting server
            logger.info('[MCPServer.start] Connecting transport');
            const transportConnectStart = Date.now();
            await this.server.connect(this.transport);
            const transportConnectTime = Date.now() - transportConnectStart;
            logger.info(`[MCPServer.start] Transport connected (took ${transportConnectTime}ms)`);

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

            // Rest of the shutdown process...
            logger.info('[MCPServer.stop] Closing transport');
            const transportCloseStart = Date.now();
            await this.transport.close();
            const transportCloseTime = Date.now() - transportCloseStart;
            logger.info(`[MCPServer.stop] Transport closed (took ${transportCloseTime}ms)`);
            
            logger.info('[MCPServer.stop] Closing MCP server');
            const serverCloseStart = Date.now();
            await this.server.close();
            const serverCloseTime = Date.now() - serverCloseStart;
            logger.info(`[MCPServer.stop] MCP server closed (took ${serverCloseTime}ms)`);
            
            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}