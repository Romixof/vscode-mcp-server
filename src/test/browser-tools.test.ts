import * as assert from 'assert';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildLaunchCommand, sensitiveReason, registerBrowserTools, launchEnvironment, resolveBrowserAlias, storeShot, getShot, notePublicOrigin, BrowserSettings, DEFAULT_BROWSER_PACKAGE } from '../tools/browser-tools';
import { scopeAllows, PRESETS } from '../auth/scopes';

const BASE: BrowserSettings = {
        command: '', packageSpec: DEFAULT_BROWSER_PACKAGE, extraArgs: [], headless: false, profile: 'dedicated', userDataDir: '', hideAutomationBanner: true,
        browserUrl: '', executablePath: '', confirm: 'sensitive', allowFileUrls: false, idleTimeoutMinutes: 30
};

suite('browser tools (Chrome DevTools MCP bridge)', () => {
        test('default launch is npx with the pinned package, no telemetry, no file:// navigation', () => {
                const { command, args } = buildLaunchCommand(BASE);
                assert.strictEqual(command, 'npx');
                assert.deepStrictEqual(args.slice(0, 2), ['-y', DEFAULT_BROWSER_PACKAGE]);
                for (const flag of ['--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux', '--no-file-navigations']) {
                        assert.ok(args.includes(flag), `missing ${flag}: ${args.join(' ')}`);
                }
        });

        test('allowFileUrls drops the file:// guard; browserUrl replaces launch flags', () => {
                const { args } = buildLaunchCommand({ ...BASE, allowFileUrls: true, browserUrl: 'http://127.0.0.1:9222', headless: true });
                assert.ok(!args.includes('--no-file-navigations'));
                assert.ok(args.includes('--browserUrl=http://127.0.0.1:9222'));
                assert.ok(!args.includes('--headless'), 'headless only applies when the bridge launches Chrome');
        });

        test('a custom command runs as is, without npx', () => {
                const { command, args } = buildLaunchCommand({ ...BASE, command: 'chrome-devtools-mcp', headless: true });
                assert.strictEqual(command, 'chrome-devtools-mcp');
                assert.ok(!args.includes('-y'));
                assert.ok(args.includes('--headless'));
        });

        test('the child keeps proxy/npm settings but not Electron or VS Code internals', () => {
                const env = launchEnvironment({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', npm_config_registry: 'https://r', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '42' });
                assert.strictEqual(env.HTTPS_PROXY, 'http://proxy:8080');
                assert.strictEqual(env.npm_config_registry, 'https://r');
                assert.strictEqual(env.ELECTRON_RUN_AS_NODE, undefined);
                assert.strictEqual(env.VSCODE_PID, undefined);
                assert.strictEqual(env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
        });

        test('the automation infobar is dropped by default, kept on request', () => {
                assert.ok(buildLaunchCommand(BASE).args.includes('--ignoreDefaultChromeArg=--enable-automation'));
                assert.ok(!buildLaunchCommand({ ...BASE, hideAutomationBanner: false }).args.some(a => a.includes('enable-automation')));
        });

        test('profile modes: myChrome attaches to the running Chrome, isolated is throwaway, userDataDir is honoured', () => {
                const mine = buildLaunchCommand({ ...BASE, profile: 'myChrome', headless: true }).args;
                assert.ok(mine.includes('--autoConnect'));
                assert.ok(!mine.includes('--headless'), 'attaching never relaunches Chrome');
                assert.ok(buildLaunchCommand({ ...BASE, profile: 'isolated' }).args.includes('--isolated'));
                assert.ok(buildLaunchCommand({ ...BASE, userDataDir: 'D:/Chrome/MCP' }).args.includes('--userDataDir=D:/Chrome/MCP'));
        });

        test('guessed Playwright-style names map to the real browser tools', () => {
                assert.deepStrictEqual(resolveBrowserAlias('browser_tabs', { action: 'list' }), [{ tool: 'browser_call_code', args: { tool: 'list_pages', args: {} } }]);
                assert.deepStrictEqual(resolveBrowserAlias('browser_take_screenshot', { type: 'png', filename: 'x.png', fullPage: false }), [{ tool: 'browser_screenshot_code', args: { format: 'png', fullPage: false } }]);
                assert.deepStrictEqual(resolveBrowserAlias('browser_navigate', { url: 'https://mammouth.ai' }), [{ tool: 'browser_open_code', args: { url: 'https://mammouth.ai' } }]);
                assert.deepStrictEqual(resolveBrowserAlias('browser_click', { ref: 'e12', element: 'Login' }), [{ tool: 'browser_click_code', args: { uid: 'e12' } }]);
                assert.strictEqual(resolveBrowserAlias('browser_type', { ref: '1_4', text: 'hi', submit: true })?.length, 2);
                assert.deepStrictEqual(resolveBrowserAlias('list_console_messages', {}), [{ tool: 'browser_call_code', args: { tool: 'list_console_messages', args: {} } }]);
                assert.strictEqual(resolveBrowserAlias('read_file', {}), undefined, 'non-browser names are left alone');
        });

        test('screenshots get an expiring public URL on the host the client used', () => {
                notePublicOrigin({ host: 'pc.tail1234.ts.net', 'x-forwarded-proto': 'https' });
                const id = storeShot(Buffer.from('abc').toString('base64'), 'image/jpeg');
                assert.match(id, /^[a-f0-9]{32}\.jpg$/);
                assert.strictEqual(getShot(id)?.data.toString(), 'abc');
                assert.strictEqual(getShot('0'.repeat(32) + '.jpg'), undefined);
        });

        test('script evaluation, uploads and local file paths always need confirmation', () => {
                assert.ok(sensitiveReason('evaluate_script', { function: '() => 1' }, 'sensitive', false));
                assert.ok(sensitiveReason('upload_file', { uid: '1', filePaths: ['a'] }, 'sensitive', false));
                assert.ok(sensitiveReason('take_screenshot', { filePath: 'C:/x.png' }, 'sensitive', false));
                assert.ok(sensitiveReason('navigate_page', { type: 'url', url: 'https://a.b', initScript: 'x' }, 'sensitive', false));
                assert.ok(sensitiveReason('new_page', { url: 'file:///C:/Users' }, 'sensitive', false));
                assert.ok(sensitiveReason('navigate_page', { type: 'url', url: 'javascript:alert(1)' }, 'sensitive', false));
        });

        test('ordinary browsing runs without a prompt in sensitive mode', () => {
                assert.strictEqual(sensitiveReason('navigate_page', { type: 'url', url: 'https://example.com' }, 'sensitive', false), undefined);
                assert.strictEqual(sensitiveReason('click', { uid: '1_2' }, 'sensitive', false), undefined);
                assert.strictEqual(sensitiveReason('take_snapshot', {}, 'sensitive', false), undefined);
        });

        test('actions mode asks before anything that is not read-only; off never asks', () => {
                assert.ok(sensitiveReason('click', { uid: '1_2' }, 'actions', false));
                assert.strictEqual(sensitiveReason('list_pages', {}, 'actions', true), undefined);
                assert.strictEqual(sensitiveReason('evaluate_script', { function: 'x' }, 'off', false), undefined);
        });

        test('registers the seven browser tools; only full keys reach them', () => {
                const server = new McpServer({ name: 't', version: '1' });
                registerBrowserTools(server);
                const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
                assert.deepStrictEqual(names, ['browser_call_code', 'browser_click_code', 'browser_close_code', 'browser_fill_code', 'browser_open_code', 'browser_screenshot_code', 'browser_snapshot_code']);
                for (const n of names) {
                        assert.ok(scopeAllows(PRESETS.full, n), `${n} must be reachable with a full key`);
                        assert.ok(!scopeAllows(PRESETS.standard, n), `${n} must not be reachable with a standard key`);
                }
        });
});
