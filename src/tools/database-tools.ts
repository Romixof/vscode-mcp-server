import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { executeShellCommand, detectShellKind } from './shell-tools';

function getWorkspaceRoot(): string {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open');
    }
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
}

let sharedTerminal: vscode.Terminal | undefined;

async function runShellCommand(command: string, cwd?: string, timeout: number = 30000): Promise<{ output: string; exitCode: number }> {
    if (!sharedTerminal) {
        throw new Error('Terminal not available for database tools');
    }
    const workspaceRoot = cwd || getWorkspaceRoot();
    try {
        // executeShellCommand resolves with the real exit code captured via marker
        // (it only rejects on timeout or read failure)
        return await executeShellCommand(sharedTerminal, command, workspaceRoot, timeout);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { output: errorMessage, exitCode: 1 };
    }
}

function parseEnvFile(content: string): Map<string, string> {
    const env = new Map<string, string>();
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
            env.set(key, value);
        }
    }
    return env;
}

export function registerDatabaseTools(server: McpServer, terminal?: vscode.Terminal): void {
    sharedTerminal = terminal;
    // 1. run_sql_query_code - Execute SQL queries
    server.tool(
        'run_sql_query_code',
        `Executes SQL queries against local databases (PostgreSQL, MySQL, SQLite).

        WHEN TO USE: Querying databases, debugging data issues, running migrations.
        
        Supports: PostgreSQL (psql), MySQL (mysql), SQLite (sqlite3).
        Auto-detects from connection string or uses default local instance.
        Returns structured results with columns and rows.`,
        {
            query: z.string().describe('SQL query to execute'),
            database: z.enum(['postgresql', 'mysql', 'sqlite']).optional().describe('Database type (auto-detected if omitted)'),
            connectionString: z.string().optional().describe('Connection string (optional, uses env vars or defaults)'),
            databaseName: z.string().optional().describe('Database name (for PostgreSQL/MySQL)'),
            filePath: z.string().optional().describe('SQLite file path (required for sqlite)'),
            format: z.enum(['json', 'table', 'csv']).optional().default('json').describe('Output format'),
            timeout: z.number().optional().default(30000).describe('Query timeout in ms')
        },
        async ({ query, database, connectionString, databaseName, filePath, format = 'json', timeout = 30000 }): Promise<CallToolResult> => {
            try {
                let cmd = '';
                const cwd = getWorkspaceRoot();

                if (database === 'sqlite' || (!database && filePath)) {
                    if (!filePath) {
                        throw new Error('filePath required for SQLite');
                    }
                    cmd = `sqlite3 "${filePath}" -${format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'column'} "${query}"`;
                } else if (database === 'postgresql' || (!database && (connectionString?.startsWith('postgresql://') || connectionString?.startsWith('postgres://')))) {
                    const conn = connectionString || `postgresql://localhost:5432/${databaseName || 'postgres'}`;
                    const cleanQuery = query.trim().replace(/;+\s*$/, '');
                    const sql = format === 'json'
                        // aggregate to real JSON — psql has no --pset=format=json
                        ? `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${cleanQuery}) AS t`
                        : query;
                    cmd = `psql "${conn}" -c "${sql.replace(/"/g, '\\"')}" ${format === 'json' ? '-t -A' : format === 'csv' ? '--csv' : ''}`;
                } else if (database === 'mysql' || (!database && (connectionString?.startsWith('mysql://')))) {
                    // the mysql CLI only accepts flag-style connections, never URLs
                    const url = new URL(connectionString || `mysql://localhost:3306/${databaseName || 'mysql'}`);
                    const host = url.hostname || 'localhost';
                    const dbPort = url.port || '3306';
                    const user = decodeURIComponent(url.username) || 'root';
                    const password = decodeURIComponent(url.password);
                    const dbName = (url.pathname || '/').slice(1);
                    const auth = password ? `-p"${password.replace(/"/g, '\\"')}"` : '';
                    cmd = `mysql -h "${host}" -P ${dbPort} -u "${user}" ${auth} ${dbName} -e "${query.replace(/"/g, '\\"')}"`;
                } else {
                    throw new Error('Database type required (postgresql, mysql, sqlite) or provide connectionString');
                }

                const result = await runShellCommand(cmd, cwd, timeout);
                return {
                    content: [{ type: 'text', text: `Query: ${query}\n\n${result.output}` }]
                };
            } catch (error) {
                console.error('[run_sql_query_code] Error:', error);
                throw error;
            }
        }
    );

    // 2. test_api_endpoint_code - HTTP requests to local APIs
    server.tool(
        'test_api_endpoint_code',
        `Makes HTTP requests to local API endpoints for testing.

        WHEN TO USE: Testing REST/GraphQL APIs, webhooks, health checks.
        
        Supports all HTTP methods, headers, body, auth. Returns status, headers, body, timing.
        Follows redirects by default.`,
        {
            url: z.string().describe('API endpoint URL (e.g., http://localhost:3000/api/users)'),
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method'),
            headers: z.record(z.string()).optional().describe('Request headers'),
            body: z.string().optional().describe('Request body (JSON, form data, etc.)'),
            timeout: z.number().optional().default(10000).describe('Request timeout in ms'),
            followRedirects: z.boolean().optional().default(true).describe('Follow redirects'),
            validateStatus: z.boolean().optional().default(false).describe('Throw on non-2xx status')
        },
        async ({ url, method = 'GET', headers = {}, body, timeout = 10000, followRedirects = true, validateStatus = false }): Promise<CallToolResult> => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const fetchOptions: RequestInit = {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        ...headers
                    },
                    signal: controller.signal,
                    redirect: followRedirects ? 'follow' : 'manual'
                };

                if (body && method !== 'GET' && method !== 'HEAD') {
                    fetchOptions.body = body;
                }

                const startTime = Date.now();
                const response = await fetch(url, fetchOptions);
                const duration = Date.now() - startTime;
                clearTimeout(timeoutId);

                const responseHeaders: Record<string, string> = {};
                response.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });

                const responseBody = await response.text();

                if (validateStatus && !response.ok) {
                    throw new Error(`HTTP ${response.status}: ${responseBody}`);
                }

                let parsedBody: any = responseBody;
                try {
                    if (responseHeaders['content-type']?.includes('application/json')) {
                        parsedBody = JSON.parse(responseBody);
                    }
                } catch {
                }

                return {
                    content: [{
                        type: 'text',
                        text: `HTTP ${method} ${url}\nStatus: ${response.status} ${response.statusText} (${duration}ms)\n\nHeaders:\n${JSON.stringify(responseHeaders, null, 2)}\n\nBody:\n${JSON.stringify(parsedBody, null, 2)}`
                    }]
                };
            } catch (error) {
                console.error('[test_api_endpoint_code] Error:', error);
                throw error;
            }
        }
    );

    // 3. check_env_vars_code - Check .env files
    server.tool(
        'check_env_vars_code',
        `Checks .env files for missing, unused, or duplicate variables.

        WHEN TO USE: Validating environment config, finding missing secrets, detecting drift.
        
        Compares .env, .env.local, .env.example, .env.*.local against code usage (process.env.VAR).
        Reports: missing in .env, unused in .env, duplicates, differences between files.`,
        {
            checkCodeUsage: z.boolean().optional().default(true).describe('Scan code for process.env.VAR references'),
            envFiles: z.array(z.string()).optional().default(['.env', '.env.local', '.env.example']).describe('Env files to check (relative to workspace)'),
            ignorePatterns: z.array(z.string()).optional().default(['node_modules', '.git', 'dist', 'build']).describe('Glob patterns to ignore')
        },
        async ({ checkCodeUsage = true, envFiles = ['.env', '.env.local', '.env.example'], ignorePatterns = ['node_modules', '.git', 'dist', 'build'] }): Promise<CallToolResult> => {
            try {
                const workspaceRoot = getWorkspaceRoot();
                const envData: Record<string, Map<string, string>> = {};
                const allKeys = new Set<string>();

                for (const envFile of envFiles) {
                    const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, envFile);
                    try {
                        const content = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
                        envData[envFile] = parseEnvFile(content);
                        for (const key of envData[envFile].keys()) {
                            allKeys.add(key);
                        }
                    } catch {
                        envData[envFile] = new Map();
                    }
                }

                let codeVars = new Set<string>();
                if (checkCodeUsage) {
                    const exclude = `{${ignorePatterns.map(p => `**/${p}/**`).join(',')}}`;
                    const files = await vscode.workspace.findFiles('**/*', exclude);
                    
                    for (const file of files.slice(0, 100)) {
                        try {
                            const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8');
                            const matches = content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g);
                            for (const match of matches) {
                                codeVars.add(match[1]);
                            }
                        } catch {
                        }
                    }
                }

                const results = {
                    envFiles: Object.keys(envData),
                    allDefinedKeys: Array.from(allKeys).sort(),
                    missingInEnv: {} as Record<string, string[]>,
                    unusedInEnv: {} as Record<string, string[]>,
                    duplicates: {} as Record<string, { file: string; value: string }[]>,
                    codeOnlyVars: Array.from(codeVars).filter(k => !allKeys.has(k)).sort(),
                    differences: {} as Record<string, { file: string; value: string }[]>
                };

                for (const [file, vars] of Object.entries(envData)) {
                    results.missingInEnv[file] = Array.from(codeVars).filter(k => !vars.has(k)).sort();
                    results.unusedInEnv[file] = Array.from(vars.keys()).filter(k => !codeVars.has(k)).sort();
                }

                for (const key of allKeys) {
                    const locations: { file: string; value: string }[] = [];
                    for (const [file, vars] of Object.entries(envData)) {
                        if (vars.has(key)) {
                            locations.push({ file, value: vars.get(key)! });
                        }
                    }
                    if (locations.length > 1) {
                        results.duplicates[key] = locations;
                    }
                    if (locations.length > 1) {
                        const values = new Set(locations.map(l => l.value));
                        if (values.size > 1) {
                            results.differences[key] = locations;
                        }
                    }
                }

                return {
                    content: [{
                        type: 'text',
                        text: `Environment Variable Analysis\n${'='.repeat(40)}\n\n` +
                            `Files checked: ${results.envFiles.join(', ')}\n` +
                            `Total unique keys: ${results.allDefinedKeys.length}\n` +
                            `Code-referenced vars: ${codeVars.size}\n\n` +
                            `Missing in .env files:\n${JSON.stringify(results.missingInEnv, null, 2)}\n\n` +
                            `Unused in .env files:\n${JSON.stringify(results.unusedInEnv, null, 2)}\n\n` +
                            `Duplicate definitions:\n${JSON.stringify(results.duplicates, null, 2)}\n\n` +
                            `Value differences:\n${JSON.stringify(results.differences, null, 2)}\n\n` +
                            `Only in code (not in any .env):\n${results.codeOnlyVars.join(', ') || '(none)'}`
                    }]
                };
            } catch (error) {
                console.error('[check_env_vars_code] Error:', error);
                throw error;
            }
        }
    );

    // 4. get_open_ports_code - List open ports and processes
    server.tool(
        'get_open_ports_code',
        `Lists open ports and associated processes on the system.

        WHEN TO USE: Finding port conflicts, identifying what's running on a port, debugging dev servers.
        
        Works on Windows, macOS, Linux. Shows PID, process name, port, protocol, state.`,
        {
            port: z.number().optional().describe('Specific port to check (optional)'),
            protocol: z.enum(['tcp', 'udp', 'all']).optional().default('all').describe('Protocol filter'),
            state: z.enum(['listening', 'established', 'all']).optional().default('listening').describe('Connection state filter')
        },
        async ({ port, protocol = 'all', state = 'listening' }): Promise<CallToolResult> => {
            try {
                const isWindows = process.platform === 'win32';
                let cmd = '';

                if (isWindows) {
                    cmd = `netstat -ano`;
                    if (protocol !== 'all') {
                        cmd += ` -p ${protocol.toUpperCase()}`;
                    }
                } else {
                    cmd = `lsof -i`;
                    if (protocol !== 'all') {
                        cmd += ` -i${protocol}`;
                    }
                    if (state === 'listening') {
                        cmd += ` -sTCP:LISTEN`;
                    } else if (state === 'established') {
                        cmd += ` -sTCP:ESTABLISHED`;
                    }
                }

                if (port) {
                    if (isWindows) {
                        cmd += ` | findstr :${port}`;
                    } else {
                        cmd += ` | grep :${port}`;
                    }
                }

                const result = await runShellCommand(cmd, undefined, 10000);

                let output = result.output;
                if (isWindows && port) {
                    output = output.split('\n')
                        .filter(l => l.includes(`:${port}`))
                        .join('\n');
                }

                return {
                    content: [{
                        type: 'text',
                        text: `Open Ports (${protocol.toUpperCase()}, ${state})\n${'='.repeat(50)}\n\n${output || 'No matching ports found'}`
                    }]
                };
            } catch (error) {
                console.error('[get_open_ports_code] Error:', error);
                throw error;
            }
        }
    );

    // 5. restart_dev_server_code - Restart dev servers
    server.tool(
        'restart_dev_server_code',
        `Restarts common development servers (Vite, Next.js, Webpack, Nodemon, etc.).

        WHEN TO USE: Hot reload stuck, config changes not picked up, clearing cache.
        
        Detects running dev servers from package.json scripts or common patterns.
        Kills existing process and restarts with same command.`,
        {
            script: z.string().optional().describe('npm script name to run (e.g., "dev", "start")'),
            command: z.string().optional().describe('Custom command to run (overrides script)'),
            cwd: z.string().optional().default('.').describe('Working directory'),
            port: z.number().optional().describe('Port the dev server runs on (for verification)'),
            killTimeout: z.number().optional().default(5000).describe('Time to wait for graceful shutdown (ms)'),
            startupTimeout: z.number().optional().default(30000).describe('Time to wait for server ready (ms)')
        },
        async ({ script, command, cwd = '.', port, killTimeout = 5000, startupTimeout = 30000 }): Promise<CallToolResult> => {
            try {
                const workspaceRoot = getWorkspaceRoot();
                const targetDir = cwd === '.' ? workspaceRoot : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, cwd).fsPath;

                let runCommand = command;
                if (!runCommand && script) {
                    runCommand = `npm run ${script}`;
                } else if (!runCommand) {
                    const pkgUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'package.json');
                    try {
                        const pkgContent = Buffer.from(await vscode.workspace.fs.readFile(pkgUri)).toString('utf-8');
                        const pkg = JSON.parse(pkgContent);
                        const devScripts = Object.keys(pkg.scripts || {}).filter(s => ['dev', 'start', 'serve', 'develop'].includes(s));
                        if (devScripts.length > 0) {
                            runCommand = `npm run ${devScripts[0]}`;
                        }
                    } catch {
                    }
                }

                if (!runCommand) {
                    throw new Error('No script or command specified, and no dev script found in package.json');
                }

                if (!sharedTerminal) {
                    throw new Error('Terminal not available for database tools');
                }
                sharedTerminal.show();
                const shellKind = detectShellKind(sharedTerminal);

                if (port) {
                    // kill syntax depends on the shell actually hosting the command
                    const killCmd = shellKind === 'bash'
                        ? `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`
                        : `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`;
                    await runShellCommand(killCmd, targetDir, killTimeout);
                    await new Promise(r => setTimeout(r, 1000));
                }

                let fullCommand = runCommand;
                if (cwd !== '.') {
                    fullCommand = shellKind === 'bash'
                        ? `cd "${targetDir.replace(/\\/g, '/')}" && ${runCommand}`
                        : `Set-Location '${targetDir.replace(/'/g, "''")}'; ${runCommand}`;
                }

                sharedTerminal.sendText(fullCommand, true);

                let verified = false;
                if (port) {
                    const startTime = Date.now();
                    while (Date.now() - startTime < startupTimeout) {
                        await new Promise(r => setTimeout(r, 1000));
                        const checkResult = await runShellCommand(
                            process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -ti:${port}`,
                            targetDir,
                            5000
                        );
                        if (checkResult.output.trim()) {
                            verified = true;
                            break;
                        }
                    }
                }

                return {
                    content: [{
                        type: 'text',
                        text: `Dev Server Restart\n${'='.repeat(40)}\n` +
                            `Command: ${runCommand}\n` +
                            `Directory: ${targetDir}\n` +
                            `Port check: ${port ? (verified ? `✅ Verified on port ${port}` : `⚠️ Not verified on port ${port} (timeout)`) : 'Skipped'}\n\n` +
                            `Server started in terminal. Check terminal output for details.`
                    }]
                };
            } catch (error) {
                console.error('[restart_dev_server_code] Error:', error);
                throw error;
            }
        }
    );
}