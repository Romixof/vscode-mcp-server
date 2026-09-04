import * as vscode from 'vscode';
import * as fs from 'fs';
import { MCPServer, ToolConfiguration } from './server';
import { listWorkspaceFiles } from './tools/file-tools';
import { logger } from './utils/logger';
import { setSandboxConfigProvider } from './utils/workspace';
import type { SandboxMode } from './utils/sandbox';
import { initAudit } from './auth/audit';
import { Dashboard, setDashboardRef } from './dashboard';
import { setSecretStorage, getStoredApiKey, generateAndStoreApiKey, clearStoredApiKey } from './auth';
import { refreshApiKeyCache } from './server';
import { readAuthConfig } from './auth';

export { MCPServer };

let mcpServer: MCPServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let sharedTerminal: vscode.Terminal | undefined;

let serverEnabled: boolean = false;

const TERMINAL_NAME = 'MCP Shell Commands';

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
        advanced: enabledTools.advanced ?? true,
        skills: enabledTools.skills ?? true
    };
}

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

export function getExtensionTerminal(context: vscode.ExtensionContext): vscode.Terminal {

    const existingTerminal = vscode.window.terminals.find(t => t.name === TERMINAL_NAME);

    if (existingTerminal && existingTerminal.exitStatus === undefined) {
        logger.info('[getExtensionTerminal] Reusing existing terminal for shell commands');
        return existingTerminal;
    }

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

function updateStatusBar(port: number) {
    if (!statusBarItem) {
        return;
    }

    if (serverEnabled && mcpServer?.cluster.getRole() === 'spoke') {

        statusBarItem.text = `$(server) MCP Server: ${port} (joined)`;
        statusBarItem.tooltip = `Sharing another VS Code window's MCP server at localhost:${port} — tool calls for this window's folders are forwarded there.\\nClick to leave the shared server.`;
        statusBarItem.backgroundColor = undefined;
    } else if (serverEnabled) {

        const remoteName = vscode.env.remoteName;
        const remoteNote = remoteName ? ` — running inside remote ${remoteName}` : '';
        statusBarItem.text = `$(server) MCP Server: ${port}`;
        statusBarItem.tooltip = `MCP Server running at localhost:${port}${remoteNote} (Click to toggle)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(server) MCP Server: Off`;
        statusBarItem.tooltip = `MCP Server is disabled (Click to toggle)`;

        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.show();
}

async function startOrJoinServer(
    context: vscode.ExtensionContext,
    options: { resetPersistedOnFailure: boolean }
): Promise<MCPServer | undefined> {
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const port = config.get<number>('port') || 3400;
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

    mcpServer.cluster.setOnStateChange(() => updateStatusBar(port));
    mcpServer.setupTools();

    try {
        await mcpServer.start();
    } catch (error) {

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

    if (serverEnabled && mcpServer.authToken && mcpServer.cluster.getRole() !== 'spoke'
        && context.globalState.get<string>('vscode-mcp.authTokenAnnounced') !== mcpServer.authToken) {
        void context.globalState.update('vscode-mcp.authTokenAnnounced', mcpServer.authToken);
        vscode.window.showInformationMessage(
            `MCP Server ready on localhost:${port}. Keep this access token — clients must send it on every call.`,
            'Copy token'
        ).then(choice => {
            if (choice === 'Copy token' && mcpServer?.authToken) {
                void vscode.env.clipboard.writeText(mcpServer.authToken as string);
                vscode.window.showInformationMessage('Access token copied to the clipboard.');
            }
        });
    }
    return mcpServer;
}

async function toggleServerState(context: vscode.ExtensionContext): Promise<void> {
    logger.info(`[toggleServerState] Starting toggle operation - changing from ${serverEnabled} to ${!serverEnabled}`);

    serverEnabled = !serverEnabled;

    context.globalState.update('mcpServerEnabled', serverEnabled);

    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const port = config.get<number>('port') || 3400;
    const host = config.get<string>('host') || '127.0.0.1';

    updateStatusBar(port);
    if (serverEnabled) {

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

            const remoteSuffix = vscode.env.remoteName ? ` (inside remote ${vscode.env.remoteName} — forward the port or connect from within the remote)` : '';
            vscode.window.showInformationMessage(
                started.cluster.getRole() === 'spoke'
                    ? `MCP Server joined the server already running at http://localhost:${port}/mcp — this window's folders are served through it${remoteSuffix}`
                    : `MCP Server enabled and running at http://localhost:${port}/mcp${remoteSuffix}`
            );
        }
    } else {

        if (mcpServer) {

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

async function ensureApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const cfg = readAuthConfig();
    if (cfg.mode !== 'api-key') {
        return undefined;
    }
    const stored = await getStoredApiKey();
    if (stored) {
        return stored;
    }
    const generated = await generateAndStoreApiKey();
    await vscode.env.clipboard.writeText(generated);
    vscode.window.showInformationMessage(
        'A new MCP Server API key was generated and copied to the clipboard. It is stored securely in VS Code SecretStorage.'
    );
    return generated;
}

const copyApiKeyCommand = vscode.commands.registerCommand(
    'vscode-mcp-server.copyApiKey',
    async () => {
        const key = await getStoredApiKey();
        if (key) {
            await vscode.env.clipboard.writeText(key);
            vscode.window.showInformationMessage('API key copied to the clipboard.');
        } else {
            vscode.window.showInformationMessage('No API key found. Start the MCP server first, or use Generate API Key.');
        }
    }
);

const generateApiKeyCommand = vscode.commands.registerCommand(
    'vscode-mcp-server.generateApiKey',
    async () => {
        await clearStoredApiKey();
        const key = await generateAndStoreApiKey();
        await vscode.env.clipboard.writeText(key);
        await refreshApiKeyCache();
        vscode.window.showInformationMessage('New API key generated and copied to the clipboard. The old key is now invalid.');
    }
);

export async function activate(context: vscode.ExtensionContext) {
    logger.info('Activating vscode-mcp-server extension');
    if (vscode.env.remoteName) {
        logger.info(`[activate] Remote environment detected: ${vscode.env.remoteName}`);
    }

    setSandboxConfigProvider(() => {
        const cfg = vscode.workspace.getConfiguration('vscode-mcp-server');
        const mode = (cfg.get<string>('security.sandbox.mode', 'workspace') || 'workspace') as SandboxMode;
        const allowPaths = cfg.get<string[]>('security.sandbox.allowPaths', []) ?? [];
        return { mode, allowPaths, homeDir: process.env.USERPROFILE || process.env.HOME };
    });
    initAudit(
        () => context.globalState.get<import('./auth/audit').AuditEvent[]>('audit.log', []),
        events => context.globalState.update('audit.log', events)
    );
    setSecretStorage(context.secrets);

    try {

        await ensureApiKey(context);
        await refreshApiKeyCache();

        const config = vscode.workspace.getConfiguration('vscode-mcp-server');
        const defaultEnabled = config.get<boolean>('defaultEnabled') ?? false;
        const port = config.get<number>('port') || 3400;
        const host = config.get<string>('host') || '127.0.0.1';

        serverEnabled = context.globalState.get('mcpServerEnabled', defaultEnabled);

        logger.info(`[activate] Using port ${port} from configuration`);
        logger.info(`[activate] Server enabled: ${serverEnabled}`);

        statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        statusBarItem.command = 'vscode-mcp-server.toggleServer';

        if (serverEnabled) {
            const started = await startOrJoinServer(context, { resetPersistedOnFailure: false });
            if (started) {
                logger.info('MCP Server started successfully');
            }

        } else {
            logger.info('MCP Server is disabled by default');
        }

        updateStatusBar(port);
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

        const dashboard = new Dashboard();
        const openDashboardCommand = vscode.commands.registerCommand('vscode-mcp-server.openDashboard', () => dashboard.show(context));
        setDashboardRef(dashboard);
        if (mcpServer) mcpServer.attachDashboard(dashboard);

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

                if (!(await startOrJoinServer(context, { resetPersistedOnFailure: true }))) {
                    return;
                }

                vscode.window.showInformationMessage('MCP Server restarted with updated configuration');
            }
        });

        const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void mcpServer?.cluster.folderSetChanged();
        });

        context.subscriptions.push(
            statusBarItem,
            toggleServerCommand,
            showServerInfoCommand,
            openDashboardCommand,
            copyAuthTokenCommand,
            copyApiKeyCommand,
            generateApiKeyCommand,
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
        throw error;
    } finally {
        mcpServer = undefined;

        logger.dispose();
    }
}
