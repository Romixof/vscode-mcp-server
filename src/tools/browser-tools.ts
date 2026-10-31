import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { logger } from '../utils/logger';
import { readAuthConfig } from '../auth';

/**
 * Browser bridge: the extension starts Chrome DevTools MCP
 * (github.com/ChromeDevTools/chrome-devtools-mcp) as a stdio child process on
 * the first browser call and relays a small, fixed set of tools on the same
 * /mcp endpoint. The tool names are static so the scope map, annotations,
 * catalog and twilight relay all know them up front; everything the upstream
 * server offers beyond the shortcuts goes through browser_call_code.
 *
 * Safety model, because the endpoint is usually reachable through a public
 * tunnel:
 * - auth.mode "none" disables every browser tool;
 * - sensitive calls (script evaluation, file uploads, anything that reads or
 *   writes a local file, non-web URLs) need a modal confirmation in VS Code;
 *   browser.confirm="actions" extends that to every non-read-only action;
 * - file:// navigation is off unless browser.allowFileUrls is set.
 */

export const DEFAULT_BROWSER_PACKAGE = 'chrome-devtools-mcp@1.12.0';
const CALL_TIMEOUT_MS = 180_000;
const CONFIRM_TIMEOUT_MS = 120_000;

export type ConfirmMode = 'sensitive' | 'actions' | 'off';
export type ProfileMode = 'dedicated' | 'myChrome' | 'isolated';

export interface BrowserSettings {
        command: string;
        packageSpec: string;
        extraArgs: string[];
        headless: boolean;
        profile: ProfileMode;
        userDataDir: string;
        hideAutomationBanner: boolean;
        browserUrl: string;
        executablePath: string;
        confirm: ConfirmMode;
        allowFileUrls: boolean;
        idleTimeoutMinutes: number;
}

export function readBrowserSettings(): BrowserSettings {
        let cfg: vscode.WorkspaceConfiguration | undefined;
        try {
                cfg = vscode.workspace.getConfiguration('vscode-mcp-server');
        } catch {
                cfg = undefined;
        }
        const get = <T>(key: string, fallback: T): T => {
                try {
                        const v = cfg?.get<T>(key);
                        return v === undefined || v === null ? fallback : v;
                } catch {
                        return fallback;
                }
        };
        const confirm = get<string>('browser.confirm', 'sensitive');
        const profile = get<string>('browser.profile', 'dedicated');
        return {
                command: get<string>('browser.command', '').trim(),
                packageSpec: get<string>('browser.package', DEFAULT_BROWSER_PACKAGE).trim() || DEFAULT_BROWSER_PACKAGE,
                extraArgs: get<string[]>('browser.extraArgs', []).filter(a => typeof a === 'string' && a.length > 0),
                headless: get<boolean>('browser.headless', false),
                profile: (profile === 'myChrome' || profile === 'isolated') ? profile : 'dedicated',
                userDataDir: get<string>('browser.userDataDir', '').trim(),
                hideAutomationBanner: get<boolean>('browser.hideAutomationBanner', true),
                browserUrl: get<string>('browser.browserUrl', '').trim(),
                executablePath: get<string>('browser.executablePath', '').trim(),
                confirm: (confirm === 'actions' || confirm === 'off') ? confirm : 'sensitive',
                allowFileUrls: get<boolean>('browser.allowFileUrls', false),
                idleTimeoutMinutes: Math.max(0, get<number>('browser.idleTimeoutMinutes', 30))
        };
}

/**
 * The command line that starts the upstream server. With browser.command
 * empty the extension runs `npx -y <package>`; otherwise browser.command is
 * the executable (e.g. a globally installed chrome-devtools-mcp) and the
 * package spec is not used.
 */
export function buildLaunchCommand(s: BrowserSettings): { command: string; args: string[] } {
        const flags: string[] = ['--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
        if (!s.allowFileUrls) { flags.push('--no-file-navigations'); }
        if (s.browserUrl) {
                flags.push(`--browserUrl=${s.browserUrl}`);
        } else if (s.profile === 'myChrome') {
                // Attach to the Chrome the user already runs (Chrome 144+, remote
                // debugging switched on at chrome://inspect/#remote-debugging):
                // their tabs, cookies and logins, no second window.
                flags.push('--autoConnect');
        } else {
                if (s.headless) { flags.push('--headless'); }
                if (s.profile === 'isolated') {
                        flags.push('--isolated');
                } else if (s.userDataDir) {
                        flags.push(`--userDataDir=${s.userDataDir}`);
                }
                if (s.executablePath) { flags.push(`--executablePath=${s.executablePath}`); }
                // Chrome's "controlled by automated test software" infobar comes
                // from this default switch; its text cannot be changed, only
                // dropped.
                if (s.hideAutomationBanner) { flags.push('--ignoreDefaultChromeArg=--enable-automation'); }
        }
        flags.push(...s.extraArgs);
        if (s.command) {
                return { command: s.command, args: flags };
        }
        return { command: 'npx', args: ['-y', s.packageSpec, ...flags] };
}

/**
 * The child inherits the extension host environment (proxy settings, npm
 * config, PATH tweaks): the SDK default keeps only a handful of variables, and
 * npx then hangs behind a corporate proxy or misses a custom npm registry.
 * Electron/VS Code internals are dropped so they cannot leak into Chrome.
 */
export function launchEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
        const env: Record<string, string> = { ...getDefaultEnvironment() };
        for (const [k, v] of Object.entries(source)) {
                if (typeof v !== 'string') { continue; }
                if (/^(ELECTRON_|VSCODE_)/i.test(k)) { continue; }
                env[k] = v;
        }
        env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = '1';
        return env;
}

interface UpstreamTool {
        name: string;
        description?: string;
        inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
        annotations?: { readOnlyHint?: boolean };
}

const FILE_ARG_KEYS = ['filePath', 'sourcePath', 'outputDirPath', 'requestFilePath', 'responseFilePath', 'filePaths', 'initScript'];
const ALWAYS_SENSITIVE = new Set(['evaluate_script', 'upload_file', 'take_heapsnapshot', 'screencast_start', 'install_extension', 'uninstall_extension', 'reload_extension', 'trigger_extension_action']);

function isWebUrl(url: unknown): boolean {
        if (typeof url !== 'string') { return true; }
        const u = url.trim().toLowerCase();
        return u.startsWith('http://') || u.startsWith('https://') || u === 'about:blank' || !/^[a-z][a-z0-9+.-]*:/.test(u);
}

/**
 * Why a call needs Rayan's click, or undefined when it can run straight away.
 * Exported for the unit tests.
 */
export function sensitiveReason(tool: string, args: Record<string, unknown>, mode: ConfirmMode, readOnly: boolean | undefined): string | undefined {
        if (mode === 'off') { return undefined; }
        if (ALWAYS_SENSITIVE.has(tool)) {
                return tool === 'evaluate_script' ? 'runs JavaScript inside the page' : `${tool} touches files or the browser itself`;
        }
        const fileKeys = FILE_ARG_KEYS.filter(k => args[k] !== undefined && args[k] !== '');
        if (fileKeys.length > 0) {
                return `uses ${fileKeys.join(', ')} (local file access or injected script)`;
        }
        if (tool === 'emulate' && typeof args.extraHttpHeaders === 'string' && args.extraHttpHeaders.length > 0) {
                return 'sets extra HTTP headers on every request';
        }
        if ((tool === 'new_page' || tool === 'navigate_page') && !isWebUrl(args.url)) {
                return `opens a non-web URL (${String(args.url)})`;
        }
        if (mode === 'actions' && readOnly !== true) {
                return 'acts on the page';
        }
        return undefined;
}

class BrowserBridge {
        private client?: Client;
        private connecting?: Promise<Client>;
        private upstreamTools = new Map<string, UpstreamTool>();
        private sessionAllowed = new Set<string>();
        private idleTimer?: NodeJS.Timeout;
        private stderrTail: string[] = [];

        isRunning(): boolean {
                return !!this.client;
        }

        async ensure(): Promise<Client> {
                if (this.client) { return this.client; }
                if (this.connecting) { return this.connecting; }
                this.connecting = this.start().finally(() => { this.connecting = undefined; });
                return this.connecting;
        }

        private async start(): Promise<Client> {
                const settings = readBrowserSettings();
                const { command, args } = buildLaunchCommand(settings);
                logger.info(`[browser] starting: ${command} ${args.join(' ')}`);
                const transport = new StdioClientTransport({
                        command,
                        args,
                        env: launchEnvironment(),
                        cwd: os.tmpdir(),
                        stderr: 'pipe'
                });
                this.stderrTail = [];
                transport.stderr?.on('data', (chunk: Buffer) => {
                        const text = chunk.toString();
                        for (const line of text.split(/\r?\n/)) {
                                if (!line.trim()) { continue; }
                                logger.info(`[browser:stderr] ${line}`);
                                this.stderrTail.push(line);
                                if (this.stderrTail.length > 15) { this.stderrTail.shift(); }
                        }
                });
                const client = new Client({ name: 'vscode-mcp-server-browser-bridge', version: '1.0.0' }, { capabilities: {} });
                client.onclose = () => {
                        if (this.client === client) {
                                logger.info('[browser] upstream server exited');
                                this.client = undefined;
                                this.upstreamTools.clear();
                        }
                };
                try {
                        await client.connect(transport);
                        const listed = await client.listTools();
                        this.upstreamTools.clear();
                        for (const t of listed.tools as UpstreamTool[]) { this.upstreamTools.set(t.name, t); }
                } catch (error) {
                        try { await client.close(); } catch { /* already gone */ }
                        const tail = this.stderrTail.slice(-6).join('\n');
                        const hint = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
                                ? `"${command}" was not found. Install Node.js 20+ (it provides npx) or set vscode-mcp-server.browser.command.`
                                : 'Check the "MCP Server Extension" output channel.';
                        throw new Error(`Could not start Chrome DevTools MCP: ${error instanceof Error ? error.message : String(error)}. ${hint}${tail ? `\n${tail}` : ''}`);
                }
                this.client = client;
                logger.info(`[browser] ready, ${this.upstreamTools.size} upstream tools`);
                try { vscode.window.setStatusBarMessage('$(globe) MCP browser started', 5000); } catch { /* no UI in tests */ }
                return client;
        }

        listUpstream(): UpstreamTool[] {
                return [...this.upstreamTools.values()];
        }

        private touch(): void {
                if (this.idleTimer) { clearTimeout(this.idleTimer); }
                const minutes = readBrowserSettings().idleTimeoutMinutes;
                if (minutes > 0) {
                        this.idleTimer = setTimeout(() => {
                                logger.info(`[browser] idle for ${minutes} min, closing`);
                                void this.stop();
                        }, minutes * 60_000);
                        this.idleTimer.unref?.();
                }
        }

        private async confirm(tool: string, args: Record<string, unknown>, reason: string): Promise<boolean> {
                if (this.sessionAllowed.has(tool)) { return true; }
                const preview = JSON.stringify(args, null, 2);
                const detail = `An MCP client asks to run "${tool}" in the browser: ${reason}.\n\nArguments:\n${preview.length > 1500 ? `${preview.slice(0, 1500)}…` : preview}`;
                const allow = 'Allow once';
                const always = `Allow "${tool}" until restart`;
                let timer: NodeJS.Timeout | undefined;
                const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), CONFIRM_TIMEOUT_MS); });
                try {
                        const choice = await Promise.race([
                                Promise.resolve(vscode.window.showWarningMessage('MCP browser: confirm this action', { modal: true, detail }, allow, always)),
                                timeout
                        ]);
                        if (choice === always) { this.sessionAllowed.add(tool); }
                        return choice === allow || choice === always;
                } catch {
                        return false;
                } finally {
                        if (timer) { clearTimeout(timer); }
                }
        }

        async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
                if (readAuthConfig().mode === 'none') {
                        return errorResult('Browser tools are disabled while vscode-mcp-server.auth.mode is "none". Use api-key, oauth or a token mode first.');
                }
                let client: Client;
                try {
                        client = await this.ensure();
                } catch (error) {
                        return errorResult(error instanceof Error ? error.message : String(error));
                }
                const upstream = this.upstreamTools.get(tool);
                if (!upstream) {
                        return errorResult(`Unknown browser tool "${tool}". Available: ${[...this.upstreamTools.keys()].join(', ')}`);
                }
                const settings = readBrowserSettings();
                const reason = sensitiveReason(tool, args, settings.confirm, upstream.annotations?.readOnlyHint);
                if (reason) {
                        const ok = await this.confirm(tool, args, reason);
                        if (!ok) {
                                logger.warn(`[browser] ${tool} refused or not confirmed (${reason})`);
                                return errorResult(`The user did not approve "${tool}" in VS Code (${reason}). Do not retry it without asking the user.`);
                        }
                }
                this.touch();
                try {
                        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
                        return result as CallToolResult;
                } catch (error) {
                        return errorResult(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
        }

        async stop(): Promise<boolean> {
                if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
                const client = this.client;
                this.client = undefined;
                this.upstreamTools.clear();
                this.sessionAllowed.clear();
                if (!client) { return false; }
                try { await client.close(); } catch { /* process already gone */ }
                logger.info('[browser] stopped');
                return true;
        }
}

function errorResult(text: string): CallToolResult {
        return { content: [{ type: 'text', text }], isError: true };
}

/** One bridge per extension host: every MCP session shares the same browser. */
export const browserBridge = new BrowserBridge();

export async function disposeBrowserBridge(): Promise<void> {
        await browserBridge.stop();
}

function compact(args: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
                if (v !== undefined) { out[k] = v; }
        }
        return out;
}

/**
 * Screenshots are also served at a short-lived, unguessable URL on this
 * server so the model can show them to the user: Mammouth renders
 * ![...](https://...) in a reply but never displays the image block a tool
 * returns. The URL is public on purpose (an <img> tag sends no bearer key):
 * 128-bit random id, 30-minute lifetime, 20 images kept at most.
 */
const SHOT_TTL_MS = 30 * 60_000;
const SHOT_MAX = 20;
const shots = new Map<string, { data: Buffer; mime: string; expires: number }>();
let publicOrigin: string | undefined;

/** Remembers how clients reach this server (funnel host or localhost). */
export function notePublicOrigin(headers: Record<string, string | string[] | undefined>): void {
        const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
        const host = first(headers['x-forwarded-host']) ?? first(headers.host);
        if (!host || !/^[a-z0-9.:[\]-]+$/i.test(host)) { return; }
        const local = /^(localhost|127\.|\[::1\])/i.test(host);
        const proto = first(headers['x-forwarded-proto']) ?? (local ? 'http' : 'https');
        publicOrigin = `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export const SHOT_ROUTE = '/browser-shot/';

export function storeShot(base64: string, mime: string): string {
        const now = Date.now();
        for (const [k, v] of shots) {
                if (v.expires < now) { shots.delete(k); }
        }
        while (shots.size >= SHOT_MAX) {
                const oldest = shots.keys().next().value;
                if (oldest === undefined) { break; }
                shots.delete(oldest);
        }
        const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
        const id = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        shots.set(id, { data: Buffer.from(base64, 'base64'), mime, expires: now + SHOT_TTL_MS });
        return id;
}

export function getShot(id: string): { data: Buffer; mime: string } | undefined {
        const hit = shots.get(id);
        if (!hit) { return undefined; }
        if (hit.expires < Date.now()) { shots.delete(id); return undefined; }
        return hit;
}

function withShotLinks(result: CallToolResult): CallToolResult {
        if (result.isError || !publicOrigin) { return result; }
        const links: string[] = [];
        for (const block of result.content ?? []) {
                if (block.type === 'image' && typeof block.data === 'string') {
                        links.push(`${publicOrigin}${SHOT_ROUTE}${storeShot(block.data, block.mimeType ?? 'image/png')}`);
                }
        }
        if (links.length === 0) { return result; }
        const text = `To SHOW this screenshot to the user, put it in your reply as Markdown: ${links.map(l => `![screenshot](${l})`).join(' ')} (link valid 30 min).`;
        return { ...result, content: [...result.content, { type: 'text', text }] };
}

/**
 * Upstream Chrome DevTools MCP tool names, and the Playwright-MCP style names
 * models guess first (live Mammouth session: browser_tabs,
 * browser_take_screenshot). A guessed name is translated to the registered
 * tool instead of failing.
 */
export const UPSTREAM_TOOL_NAMES = new Set([
        'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form', 'get_console_message',
        'get_css_styles', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit', 'list_console_messages',
        'list_network_requests', 'list_pages', 'navigate_page', 'new_page', 'performance_analyze_insight',
        'performance_start_trace', 'performance_stop_trace', 'press_key', 'resize_page', 'screencast_start',
        'screencast_stop', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot', 'type_text',
        'upload_file', 'wait_for'
]);

export interface AliasStep { tool: string; args: Record<string, unknown> }

const via = (tool: string, args: Record<string, unknown> = {}): AliasStep => ({ tool: 'browser_call_code', args: { tool, args } });

function refOf(a: Record<string, unknown>): string | undefined {
        const r = a.uid ?? a.ref ?? a.element_uid;
        return typeof r === 'string' ? r : undefined;
}

/**
 * Translates a tool name that is not registered into the browser tool(s)
 * that do the job, or returns undefined when the name means nothing here.
 */
export function resolveBrowserAlias(name: string, rawArgs: Record<string, unknown> | undefined): AliasStep[] | undefined {
        const a = rawArgs ?? {};
        const n = name.trim().toLowerCase().replace(/^mcp_|^chrome_devtools_|^chrome-devtools[_.]/, '');
        const pageIdx = (): number | undefined => {
                const v = a.pageId ?? a.index ?? a.page;
                return typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
        };
        switch (n) {
                case 'browser_navigate': case 'browser_goto': case 'browser_open': case 'navigate': case 'open_url':
                        return [{ tool: 'browser_open_code', args: { url: a.url, ...(a.newTab ? { newTab: true } : {}) } }];
                case 'browser_navigate_back': return [via('navigate_page', { type: 'back' })];
                case 'browser_navigate_forward': return [via('navigate_page', { type: 'forward' })];
                case 'browser_reload': return [via('navigate_page', { type: 'reload' })];
                case 'browser_snapshot': case 'snapshot': case 'take_snapshot':
                        return [{ tool: 'browser_snapshot_code', args: typeof a.verbose === 'boolean' ? { verbose: a.verbose } : {} }];
                case 'browser_take_screenshot': case 'browser_screenshot': case 'screenshot': case 'take_screenshot': {
                        const format = a.format ?? a.type;
                        const out: Record<string, unknown> = {};
                        if (format === 'png' || format === 'jpeg' || format === 'webp') { out.format = format; }
                        if (typeof a.fullPage === 'boolean') { out.fullPage = a.fullPage; }
                        const uid = refOf(a);
                        if (uid) { out.uid = uid; }
                        return [{ tool: 'browser_screenshot_code', args: out }];
                }
                case 'browser_click': case 'click':
                        return [{ tool: 'browser_click_code', args: { uid: refOf(a), ...(a.doubleClick || a.dblClick ? { dblClick: true } : {}) } }];
                case 'browser_type': case 'browser_fill': case 'fill': {
                        const steps: AliasStep[] = [{ tool: 'browser_fill_code', args: { uid: refOf(a), value: a.text ?? a.value } }];
                        if (a.submit === true) { steps.push(via('press_key', { key: 'Enter' })); }
                        return steps;
                }
                case 'browser_fill_form': case 'fill_form': {
                        const list = (a.fields ?? a.elements) as Array<Record<string, unknown>> | undefined;
                        return [{ tool: 'browser_fill_code', args: { elements: (list ?? []).map(f => ({ uid: refOf(f), value: String(f.value ?? '') })) } }];
                }
                case 'browser_select_option': {
                        const values = a.values as unknown[] | undefined;
                        return [{ tool: 'browser_fill_code', args: { uid: refOf(a), value: String(values?.[0] ?? a.value ?? '') } }];
                }
                case 'browser_press_key': return [via('press_key', { key: a.key })];
                case 'browser_hover': return [via('hover', { uid: refOf(a) })];
                case 'browser_drag': return [via('drag', { from_uid: a.startRef ?? a.from_uid, to_uid: a.endRef ?? a.to_uid })];
                case 'browser_evaluate': {
                        const uid = refOf(a);
                        return [via('evaluate_script', { function: a.function ?? a.script, ...(uid ? { args: [uid] } : {}) })];
                }
                case 'browser_wait_for': {
                        if (a.text !== undefined) { return [via('wait_for', { text: Array.isArray(a.text) ? a.text : [String(a.text)] })]; }
                        if (a.textGone !== undefined) { return [via('wait_for', { text: [String(a.textGone)] })]; }
                        return [via('list_pages')];
                }
                case 'browser_console_messages': return [via('list_console_messages')];
                case 'browser_network_requests': return [via('list_network_requests')];
                case 'browser_handle_dialog':
                        return [via('handle_dialog', { action: a.accept === false || a.action === 'dismiss' ? 'dismiss' : 'accept', ...(a.promptText ? { promptText: a.promptText } : {}) })];
                case 'browser_resize': return [via('resize_page', { width: a.width, height: a.height })];
                case 'browser_close': case 'close_browser': return [{ tool: 'browser_close_code', args: {} }];
                case 'browser_list_pages': case 'browser_pages': case 'list_tabs': return [via('list_pages')];
                case 'browser_tabs': case 'browser_tab': {
                        const action = String(a.action ?? 'list');
                        const idx = pageIdx();
                        if (action === 'new') { return [via('new_page', { url: typeof a.url === 'string' ? a.url : 'about:blank' })]; }
                        if (action === 'select' && idx !== undefined) { return [via('select_page', { pageId: idx, bringToFront: true })]; }
                        if (action === 'close' && idx !== undefined) { return [via('close_page', { pageId: idx })]; }
                        return [via('list_pages')];
                }
        }
        const bare = n.startsWith('browser_') ? n.slice('browser_'.length) : n;
        if (UPSTREAM_TOOL_NAMES.has(bare)) {
                const args = { ...a };
                if (args.ref !== undefined && args.uid === undefined) { args.uid = args.ref; delete args.ref; }
                return [via(bare, args)];
        }
        return undefined;
}

/**
 * Runs the alias steps through a lookup of registered (scope-wrapped)
 * handlers and stitches their results, saying which tool really ran so the
 * model learns the right name.
 */
export async function runBrowserAlias(
        guessed: string,
        steps: AliasStep[],
        run: (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>
): Promise<CallToolResult> {
        const content: CallToolResult['content'] = [];
        let isError = false;
        for (const step of steps) {
                const result = await run(step.tool, step.args);
                content.push(...(result.content ?? []));
                if (result.isError) { isError = true; break; }
        }
        const real = steps.map(s => s.tool === 'browser_call_code' ? `browser_call_code(tool="${String((s.args as { tool?: unknown }).tool)}")` : s.tool).join(' then ');
        content.push({ type: 'text', text: `(Note: "${guessed}" is not a tool here; ran ${real} instead. Use that name next time.)` });
        return { content, ...(isError ? { isError: true } : {}) };
}

export function registerBrowserTools(server: McpServer): void {
        server.tool(
                'browser_open_code',
                'Opens a URL in the Chrome browser this server drives (started on first use). Then browser_snapshot_code.',
                {
                        url: z.string(),
                        newTab: z.boolean().optional().describe('New tab. Default false.')
                },
                async ({ url, newTab }): Promise<CallToolResult> => newTab
                        ? browserBridge.call('new_page', { url })
                        : browserBridge.call('navigate_page', { type: 'url', url })
        );

        server.tool(
                'browser_snapshot_code',
                'Text snapshot of the selected tab; each element has the uid click/fill need. Re-take after page changes.',
                {
                        verbose: z.boolean().optional()
                },
                async ({ verbose }): Promise<CallToolResult> => browserBridge.call('take_snapshot', compact({ verbose }))
        );

        server.tool(
                'browser_screenshot_code',
                'Screenshot of the selected tab or one element (uid).',
                {
                        fullPage: z.boolean().optional(),
                        uid: z.string().optional(),
                        format: z.enum(['png', 'jpeg', 'webp']).optional()
                },
                async ({ fullPage, uid, format }): Promise<CallToolResult> => withShotLinks(await browserBridge.call('take_screenshot', compact({ fullPage, uid, format })))
        );

        server.tool(
                'browser_click_code',
                'Clicks an element by uid from browser_snapshot_code.',
                {
                        uid: z.string(),
                        dblClick: z.boolean().optional()
                },
                async ({ uid, dblClick }): Promise<CallToolResult> => browserBridge.call('click', compact({ uid, dblClick }))
        );

        server.tool(
                'browser_fill_code',
                'Fills an input or select by uid, or a whole form with elements=[{uid,value}].',
                {
                        uid: z.string().optional(),
                        value: z.string().optional().describe('"true"/"false" for checkboxes.'),
                        elements: z.array(z.object({ uid: z.string(), value: z.string() })).optional()
                },
                async ({ uid, value, elements }): Promise<CallToolResult> => {
                        if (elements && elements.length > 0) {
                                return browserBridge.call('fill_form', { elements });
                        }
                        if (!uid || value === undefined) {
                                return errorResult('Pass uid and value, or elements=[{uid,value}].');
                        }
                        return browserBridge.call('fill', { uid, value });
                }
        );

        server.tool(
                'browser_call_code',
                'Runs any Chrome DevTools MCP tool by name (list_pages, select_page, press_key, type_text, wait_for, evaluate_script, list_console_messages, list_network_requests, lighthouse_audit...). tool="list" lists them with params. Sensitive calls wait for approval in VS Code.',
                {
                        tool: z.string(),
                        args: z.record(z.unknown()).optional()
                },
                async ({ tool, args }): Promise<CallToolResult> => {
                        if (tool === 'list') {
                                if (readAuthConfig().mode === 'none') {
                                        return errorResult('Browser tools are disabled while vscode-mcp-server.auth.mode is "none".');
                                }
                                try {
                                        await browserBridge.ensure();
                                } catch (error) {
                                        return errorResult(error instanceof Error ? error.message : String(error));
                                }
                                const lines = browserBridge.listUpstream().map(t => {
                                        const props = Object.keys(t.inputSchema?.properties ?? {});
                                        const req = new Set(t.inputSchema?.required ?? []);
                                        const sig = props.map(p => req.has(p) ? p : `${p}?`).join(', ');
                                        const desc = (t.description ?? '').split('\n')[0].slice(0, 140);
                                        return `${t.annotations?.readOnlyHint ? '[RO] ' : ''}${t.name}(${sig}) — ${desc}`;
                                });
                                return { content: [{ type: 'text', text: lines.join('\n') }] };
                        }
                        const result = await browserBridge.call(tool, args ?? {});
                        return tool === 'take_screenshot' ? withShotLinks(result) : result;
                }
        );

        server.tool(
                'browser_close_code',
                'Closes the browser; the next browser call restarts it.',
                {},
                async (): Promise<CallToolResult> => {
                        const wasRunning = await browserBridge.stop();
                        return { content: [{ type: 'text', text: wasRunning ? 'Browser closed.' : 'The browser was not running.' }] };
                }
        );
}
