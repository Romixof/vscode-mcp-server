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

export class MCPServer {
    private server: McpServer;
    private transport: StreamableHTTPServerTransport;
    private app: express.Application;
    private httpServer?: Server;
    private port: number;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;

    public setFileListingCallback(callback: FileListingCallback) {
        this.fileListingCallback = callback;
    }

    constructor(port: number = 3000, terminal?: vscode.Terminal) {
        this.port = port;
        this.terminal = terminal;
        this.app = express();
        this.app.use(express.json());

        // Initialize MCP Server
        this.server = new McpServer({
            name: "vscode-mcp-server",
            version: "1.0.0",
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
        // Register tools from the tools module
        if (this.fileListingCallback) {
            // Register file tools
            registerFileTools(this.server, this.fileListingCallback);
            console.log('MCP file tools registered successfully');
            
            // Register edit tools
            registerEditTools(this.server);
            console.log('MCP edit tools registered successfully');
            
            // Register shell tools
            registerShellTools(this.server, this.terminal);
            console.log('MCP shell tools registered successfully');
            
            // Register diagnostics tools
            registerDiagnosticsTools(this.server);
            console.log('MCP diagnostics tools registered successfully');
        } else {
            console.warn('File listing callback not set during tools setup');
        }
    }

    private setupRoutes(): void {
        // Handle POST requests for client-to-server communication
        this.app.post('/mcp', async (req, res) => {
            console.log(`Request received: ${req.method} ${req.url}`, { body: req.body });
            try {
                await this.transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('Error handling MCP request:', error);
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
            console.log('Received SSE connection request');
            try {
                await this.transport.handleRequest(req, res, undefined);
            } catch (error) {
                console.error('Error handling SSE request:', error);
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

        // Handle unsupported methods
        this.app.get('/mcp', async (req, res) => {
            console.log('Received GET MCP request');
            res.writeHead(405).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Method not allowed."
                },
                id: null
            }));
        });

        this.app.delete('/mcp', async (req, res) => {
            console.log('Received DELETE MCP request');
            res.writeHead(405).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Method not allowed."
                },
                id: null
            }));
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
                console.error(`[Server] HTTP Server Error:`, error);
            });

            this.httpServer.on('listening', () => {
                console.log(`[Server] HTTP Server ready`);
            });

            this.httpServer.on('close', () => {
                console.log(`[Server] HTTP Server closed`);
            });
        }
    }

    public async start(): Promise<void> {
        try {
            // Connect transport before starting server
            await this.server.connect(this.transport);

            // Start HTTP server
            return new Promise((resolve) => {
                // Bind to localhost only for security
                this.httpServer = this.app.listen(this.port, '127.0.0.1', () => {
                    console.log(`MCP Server listening on localhost:${this.port}`);
                    resolve();
                });
            });
        } catch (error) {
            console.error('Failed to start MCP Server:', error);
            throw error;
        }
    }

    public async stop(): Promise<void> {
        console.log('[MCPServer.stop] Starting server shutdown process');
        const stopStartTime = Date.now();
        
        try {
            // Close HTTP server
            if (this.httpServer) {
                console.log('[MCPServer.stop] Closing HTTP server');
                const httpServerCloseStart = Date.now();
                
                await new Promise<void>((resolve, reject) => {
                    this.httpServer!.close((err) => {
                        const httpCloseTime = Date.now() - httpServerCloseStart;
                        console.log(`[MCPServer.stop] HTTP server closed ${err ? 'with error' : 'successfully'} (took ${httpCloseTime}ms)`);
                        
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            // Close transport
            console.log('[MCPServer.stop] Closing transport');
            const transportCloseStart = Date.now();
            await this.transport.close();
            const transportCloseTime = Date.now() - transportCloseStart;
            console.log(`[MCPServer.stop] Transport closed (took ${transportCloseTime}ms)`);
            
            // Close server
            console.log('[MCPServer.stop] Closing MCP server');
            const serverCloseStart = Date.now();
            await this.server.close();
            const serverCloseTime = Date.now() - serverCloseStart;
            console.log(`[MCPServer.stop] MCP server closed (took ${serverCloseTime}ms)`);
            
            const totalStopTime = Date.now() - stopStartTime;
            console.log(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            console.error('Error during server shutdown:', error);
            throw error;
        }
    }
}