import * as vscode from 'vscode';
import * as fs from 'fs';
import { MCPServer, ToolConfiguration } from './server';
import { listWorkspaceFiles } from './tools/file-tools';
import { logger } from './utils/logger';

// Re-export for testing purposes
export { MCPServer };

let mcpServer: MCPServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let sharedTerminal: vscode.Terminal | undefined;
// Server state - disabled by default
let serverEnabled: boolean = false;

// Terminal name constant
const TERMINAL_NAME = 'MCP Shell Commands';

/**
 * Gets the tool configuration from VS Code settings
 * @returns ToolConfiguration object with all tool enablement settings
 */
function getToolConfiguration(): ToolConfiguration {
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const enabledTools = config.get<any>('enabledTools') || {};
    
    return {
        file: enabledTools.file ?? true,
        edit: enabledTools.edit ?? true,
        shell: enabledTools.shell ?? true,
        diagnostics: enabledTools.diagnostics ?? true,
        symbol: enabledTools.symbol ?? true,
        memory: enabledTools.memory ?? true,
        test: enabledTools.test ?? true,
        git: enabledTools.git ?? true,
        documentation: enabledTools.documentation ?? true,
        database: enabledTools.database ?? true,
        productivity: enabledTools.productivity ?? true,
        security: enabledTools.security ?? true,
        performance: enabledTools.performance ?? true,
        refactoring: enabledTools.refactoring ?? true,
        frontend: enabledTools.frontend ?? true,
        workflow: enabledTools.workflow ?? true,
        advanced: enabledTools.advanced ?? true
    };
}

// Common Git Bash install locations probed on Windows so the MCP terminal gets
// a POSIX shell (PowerShell 5.1 rejects the `&&` chains and heredocs tools emit)
const GIT_BASH_CANDIDATES = process.platform === 'win32' ? [
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LocalAppData || ''}\\Programs\\Git\\bin\\bash.exe`
].filter(p => p.length > 0 && !p.startsWith('\\')) : [];

function findGitBash(): string | undefined {
    for (const candidate of GIT_BASH_CANDIDATES) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
        }
    }
    return undefined;
}

/**
 * Gets or creates the shared terminal for the extension
 * @param context The extension context
 * @returns The shared terminal instance
 */
export function getExtensionTerminal(context: vscode.ExtensionContext): vscode.Terminal {
    // Check if a terminal with our name already exists
    const existingTerminal = vscode.window.terminals.find(t => t.name === TERMINAL_NAME);

    if (existingTerminal && existingTerminal.exitStatus === undefined) {
        // Reuse the existing terminal if it's still open
        logger.info('[getExtensionTerminal] Reusing existing terminal for shell commands');
        return existingTerminal;
    }

    // On Windows prefer Git Bash explicitly; the default profile is usually
    // PowerShell 5.1 which cannot run the POSIX command lines the tools emit
    const bashPath = findGitBash();
    if (bashPath) {
        sharedTerminal = vscode.window.createTerminal({ name: TERMINAL_NAME, shellPath: bashPath });
        logger.info(`[getExtensionTerminal] Created new terminal using Git Bash (${bashPath})`);
    } else {
        sharedTerminal = vscode.window.createTerminal(TERMINAL_NAME);
        logger.info('[getExtensionTerminal] Created new terminal with default profile');
    }
    context.subscriptions.push(sharedTerminal);

    return sharedTerminal;
}

// Function to update status bar
function updateStatusBar(port: number) {
    if (!statusBarItem) {
        return;
    }

    if (serverEnabled && mcpServer?.cluster.getRole() === 'spoke') {
        // Joined window: another window owns the client URL; this one only
        // serves its folders to the hub through an ephemeral loopback port.
        // Healthy state, so deliberately no warning background — Off keeps it
        statusBarItem.text = `$(server) MCP Server: ${port} (joined)`;
        statusBarItem.tooltip = `Sharing another VS Code window's MCP server at localhost:${port} — tool calls for this window's folders are forwarded there.\nClick to leave the shared server.`;
        statusBarItem.backgroundColor = undefined;
    } else if (serverEnabled) {
        // Inside a devcontainer/WSL/SSH window the server binds the REMOTE's
        // localhost, so say so before someone wonders why their client can't connect
        const remoteName = vscode.env.remoteName;
        const remoteNote = remoteName ? ` — running inside remote "${remoteName}"` : '';
        statusBarItem.text = `$(server) MCP Server: ${port}`;
        statusBarItem.tooltip = `MCP Server running at localhost:${port}${remoteNote} (Click to toggle)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(server) MCP Server: Off`;
        statusBarItem.tooltip = `MCP Server is disabled (Click to toggle)`;
        // Use a subtle color to indicate disabled state
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.show();
}

/**
 * Builds, wires and starts one server instance. Toggle, autostart and
 * config-restart all funnel through here so cluster wiring (state-change
 * hook, file-listing callback) cannot drift between the three paths.
 * Returns the running server, or undefined after reporting a failed start;
 * the caller decides whether the persisted enabled flag survives that.
 */
async function startOrJoinServer(
    context: vscode.ExtensionContext,
    options: { resetPersistedOnFailure: boolean }
): Promise<MCPServer | undefined> {
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const port = config.get<number>('port') || 3000;
    const host = config.get<string>('host') || '127.0.0.1';
    const terminal = getExtensionTerminal(context);

    mcpServer = new MCPServer(port, host, terminal, getToolConfiguration());
    mcpServer.extensionContext = context;
    mcpServer.setFileListingCallback(async (path: string, recursive: boolean, workspace?: string) => {
        try {
            return await listWorkspaceFiles(path, recursive, workspace);
        } catch (error) {
            logger.error(`[startOrJoinServer] Error listing files: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    });
    // Elections and promotions move this window between roles at runtime;
    // the bar must follow without waiting for a config event
    mcpServer.cluster.setOnStateChange(() => updateStatusBar(port));
    mcpServer.setupTools();

    try {
        await mcpServer.start();
    } catch (error) {
        // Nothing is listening; flip the toggle back so the status bar
        // does not advertise a dead server
        mcpServer = undefined;
        serverEnabled = false;
        if (options.resetPersistedOnFailure) {
            void context.globalState.update('mcpServerEnabled', false);
        }
        updateStatusBar(port);
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[startOrJoinServer] Failed to start server: ${message}`);
        vscode.window.showErrorMessage(`MCP Server failed to start: ${message}`);
        return undefined;
    }
    return mcpServer;
}

// Function to toggle server state
async function toggleServerState(context: vscode.ExtensionContext): Promise<void> {
    logger.info(`[toggleServerState] Starting toggle operation - changing from ${serverEnabled} to ${!serverEnabled}`);
    
    serverEnabled = !serverEnabled;
    
    // Store state for persistence
    context.globalState.update('mcpServerEnabled', serverEnabled);
    
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const port = config.get<number>('port') || 3000;
    const host = config.get<string>('host') || '127.0.0.1';
    
    // Update status bar immediately to provide feedback
    updateStatusBar(port);
    
    if (serverEnabled) {
        // Start the server if it was disabled
        if (!mcpServer) {
            logger.info(`[toggleServerState] Creating MCP server instance`);

            logger.info(`[toggleServerState] Starting server at ${new Date().toISOString()}`);
            const startTime = Date.now();

            const started = await startOrJoinServer(context, { resetPersistedOnFailure: true });
            if (!started) {
                return;
            }

            const duration = Date.now() - startTime;
            logger.info(`[toggleServerState] Server started successfully at ${new Date().toISOString()} (took ${duration}ms)`);

            const remoteSuffix = vscode.env.remoteName ? ` (inside remote "${vscode.env.remoteName}" — forward the port or connect from within the remote)` : '';
            vscode.window.showInformationMessage(
                started.cluster.getRole() === 'spoke'
                    ? `MCP Server joined the server already running at http://localhost:${port}/mcp — this window's folders are served through it${remoteSuffix}`
                    : `MCP Server enabled and running at http://localhost:${port}/mcp${remoteSuffix}`
            );
        }
    } else {
        // Stop the server if it was enabled
        if (mcpServer) {
            // Show progress indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Stopping MCP Server',
                cancellable: false
            }, async (progress) => {
                logger.info(`[toggleServerState] Stopping server at ${new Date().toISOString()}`);
                progress.report({ message: 'Closing connections...' });
                
                const stopTime = Date.now();
                if (mcpServer) {
                    await mcpServer.stop();
                }
                
                const duration = Date.now() - stopTime;
                logger.info(`[toggleServerState] Server stopped successfully at ${new Date().toISOString()} (took ${duration}ms)`);
                
                mcpServer = undefined;
            });
            
            vscode.window.showInformationMessage('MCP Server has been disabled');
        }
    }
    
    logger.info(`[toggleServerState] Toggle operation completed`);
}

export async function activate(context: vscode.ExtensionContext) {
    logger.info('Activating vscode-mcp-server extension');
    if (vscode.env.remoteName) {
        logger.info(`[activate] Remote environment detected: "${vscode.env.remoteName}" — the server binds this host's localhost only`);
    }

    try {
        // Get configuration
        const config = vscode.workspace.getConfiguration('vscode-mcp-server');
        const defaultEnabled = config.get<boolean>('defaultEnabled') ?? false;
        const port = config.get<number>('port') || 3000;
        const host = config.get<string>('host') || '127.0.0.1';

        // Load saved state or use configured default
        serverEnabled = context.globalState.get('mcpServerEnabled', defaultEnabled);
        
        logger.info(`[activate] Using port ${port} from configuration`);
        logger.info(`[activate] Server enabled: ${serverEnabled}`);

        // Create status bar item
        statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        statusBarItem.command = 'vscode-mcp-server.toggleServer';
        
        // Only start the server if enabled
        if (serverEnabled) {
            const started = await startOrJoinServer(context, { resetPersistedOnFailure: false });
            if (started) {
                logger.info('MCP Server started successfully');
            }
            // A failed auto-start must not wedge activation: it was reported,
            // dropped and shown as off inside the helper. The saved enabled
            // state stays, so the next window load retries alone
        } else {
            logger.info('MCP Server is disabled by default');
        }
        
        // Update status bar after server state is determined
        updateStatusBar(port);

        // Register commands
        const toggleServerCommand = vscode.commands.registerCommand(
            'vscode-mcp-server.toggleServer', 
            () => toggleServerState(context)
        );

        const showServerInfoCommand = vscode.commands.registerCommand(
            'vscode-mcp-server.showServerInfo',
            () => {
                if (serverEnabled) {
                    vscode.window.showInformationMessage(`MCP Server is running at http://localhost:${port}/mcp`);
                } else {
                    vscode.window.showInformationMessage('MCP Server is currently disabled. Click on the status bar item to enable it.');
                }
            }
        );

        const copyAuthTokenCommand = vscode.commands.registerCommand(
            'vscode-mcp-server.copyAuthToken',
            async () => {
                const token = mcpServer?.authToken
                    ?? context.globalState.get<string>('vscode-mcp.authToken');
                if (!token) {
                    vscode.window.showInformationMessage('No access token yet — start the MCP server first.');
                    return;
                }
                await vscode.env.clipboard.writeText(token);
                vscode.window.showInformationMessage('MCP access token copied to the clipboard.');
            }
        );

        // Listen for configuration changes to restart server if needed
        const configChangeListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
            const relevant =
                event.affectsConfiguration('vscode-mcp-server.enabledTools') ||
                event.affectsConfiguration('vscode-mcp-server.port') ||
                event.affectsConfiguration('vscode-mcp-server.host');
            if (!relevant) {
                return;
            }
            logger.info('[configChangeListener] Server configuration changed - restarting if enabled');
            if (serverEnabled && mcpServer) {
                await mcpServer.stop();
                mcpServer = undefined;

                // Full stop/start cycle: a hub port change would otherwise
                // leave every joined spoke pointing at an abandoned port
                if (!(await startOrJoinServer(context, { resetPersistedOnFailure: true }))) {
                    return;
                }

                vscode.window.showInformationMessage('MCP Server restarted with updated configuration');
            }
        });

        // Folders opened or closed mid-session must reach the hub right away:
        // until re-registration the router either misses them or forwards
        // calls for folders this window no longer has
        const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void mcpServer?.cluster.folderSetChanged();
        });

        // Add all disposables to the context subscriptions
        context.subscriptions.push(
            statusBarItem,
            toggleServerCommand,
            showServerInfoCommand,
            copyAuthTokenCommand,
            configChangeListener,
            workspaceFoldersListener,
            { dispose: async () => mcpServer && await mcpServer.stop() }
        );
    } catch (error) {
        logger.error(`Failed to start MCP Server: ${error instanceof Error ? error.message : 'Unknown error'}`);
        vscode.window.showErrorMessage(`Failed to start MCP Server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export async function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
        statusBarItem = undefined;
    }

    // Dispose the shared terminal
    if (sharedTerminal) {
        sharedTerminal.dispose();
        sharedTerminal = undefined;
    }

    if (!mcpServer) {
        return;
    }
    
    try {
        logger.info('Stopping MCP Server during extension deactivation');
        await mcpServer.stop();
        logger.info('MCP Server stopped successfully');
    } catch (error) {
        logger.error(`Error stopping MCP Server: ${error instanceof Error ? error.message : String(error)}`);
        throw error; // Re-throw to ensure VS Code knows about the failure
    } finally {
        mcpServer = undefined;
        // Dispose the logger
        logger.dispose();
    }
}