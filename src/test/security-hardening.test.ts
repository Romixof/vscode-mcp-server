import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import proxyquire from 'proxyquire';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isLocalPeer, isRelayedRequest } from '../auth/local-peer';
import { quoteArg, shellSafeInputPath } from '../utils/shell-quote';
import { runGit, gitRevision } from '../utils/git-exec';
import { MCPServer } from '../server';
import { INVOKE_PATH, CLUSTER_REGISTER_PATH } from '../cluster/types';

function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sec-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    return dir;
}

// Payloads that run a command in bash or PowerShell if they ever reach a shell.
function payloads(marker: string): string[] {
    return [
        `$(node -e "require('fs').writeFileSync('${marker}','x')")`,
        `\`node -e "require('fs').writeFileSync('${marker}','x')"\``,
        `"; node -e "require('fs').writeFileSync('${marker}','x')"; "`,
        `' ; node -e "require('fs').writeFileSync('${marker}','x')" ; '`
    ];
}

async function callTool(register: (s: McpServer) => void, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const server = new McpServer({ name: 't', version: '0' });
    register(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(ct);
    try {
        const res = await client.callTool({ name, arguments: args }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
        return { text: (res.content ?? []).map(c => c.text ?? '').join('\n'), isError: res.isError };
    } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
    } finally {
        await client.close();
        await server.close();
    }
}

suite('security hardening (audit 2026-10-31)', () => {
    suite('local peer detection (funnel traffic arrives from 127.0.0.1)', () => {
        const sock = (remoteAddress: string) => ({ remoteAddress });
        test('a direct loopback call from another window is local', () => {
            assert.strictEqual(isLocalPeer({ headers: { host: '127.0.0.1:3400' }, socket: sock('127.0.0.1') }), true);
            assert.strictEqual(isLocalPeer({ headers: { host: 'localhost:51234' }, socket: sock('::ffff:127.0.0.1') }), true);
        });
        test('a funnel request is not local: public Host header', () => {
            assert.strictEqual(isLocalPeer({ headers: { host: 'pc.tail1234.ts.net' }, socket: sock('127.0.0.1') }), false);
        });
        test('a relayed request is not local: proxy headers', () => {
            for (const h of ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'tailscale-funnel-request']) {
                const headers: Record<string, string> = { host: '127.0.0.1:3400', [h]: '1.2.3.4' };
                assert.strictEqual(isRelayedRequest(headers), true, h);
                assert.strictEqual(isLocalPeer({ headers, socket: sock('127.0.0.1') }), false, h);
            }
        });
        test('a LAN peer is not local', () => {
            assert.strictEqual(isLocalPeer({ headers: { host: '127.0.0.1:3400' }, socket: sock('192.168.1.20') }), false);
        });
    });

    suite('shell quoting safe in bash and PowerShell', () => {
        test('plain values are single-quoted', () => {
            assert.strictEqual(quoteArg('C:\\Docs\\file name.pdf'), `'C:\\Docs\\file name.pdf'`);
            assert.strictEqual(quoteArg('a$(calc)b'), `'a$(calc)b'`);
        });
        test('quotes and control characters are refused, not escaped', () => {
            for (const bad of [`a'b`, 'a\u2019b', 'a\u2018b', 'a\nb']) {
                assert.throws(() => quoteArg(bad), /quote or a control character/);
            }
        });
        test('an input file whose name holds an apostrophe is used through a plain-named copy', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-q-'));
            const src = path.join(dir, `l'été.pdf`);
            fs.writeFileSync(src, 'PDF');
            const safe = shellSafeInputPath(src);
            assert.notStrictEqual(safe, src);
            assert.doesNotThrow(() => quoteArg(safe));
            assert.strictEqual(fs.readFileSync(safe, 'utf8'), 'PDF');
            assert.strictEqual(shellSafeInputPath(path.join(dir, 'x.pdf')), path.join(dir, 'x.pdf'));
        });
    });

    suite('git runs without a shell', function () {
        if (!hasGit()) {
            test('git not installed — skipped', () => undefined);
            return;
        }
        test('runGit passes hostile values as plain arguments', async () => {
            const repo = makeRepo();
            const marker = path.join(repo, 'PWNED');
            for (const p of payloads(marker)) {
                await runGit(['log', `--author=${p}`, `--grep=${p}`, '--', p], repo);
            }
            assert.strictEqual(fs.existsSync(marker), false);
        });
        test('a revision that starts with "-" is refused (no option injection)', () => {
            assert.throws(() => gitRevision('--output=/tmp/x'));
            assert.strictEqual(gitRevision('main'), 'main');
        });

        const workspaceStub = (repo: string) => ({
            resolveWorkspaceFolder: () => ({ uri: { fsPath: repo }, name: 'repo' }),
            resolveRelativeToolPath: (input: string) => ({
                root: repo, relative: input, fsPath: path.join(repo, input), dir: repo,
                gitPath: input, displayPrefix: '', displayBase: '', owned: true
            }),
            WORKSPACE_PARAM_DESCRIPTION: 'Workspace root'
        });

        test('get_file_history_code (read-only scope) cannot run commands', async () => {
            const repo = makeRepo();
            const marker = path.join(repo, 'PWNED');
            const docs = proxyquire('../tools/documentation-tools', { '../utils/workspace': workspaceStub(repo) }) as { registerDocumentationTools(s: McpServer): void };
            for (const p of payloads(marker)) {
                await callTool(s => docs.registerDocumentationTools(s), 'get_file_history_code',
                    { path: 'a.txt', author: p, since: p, until: p, grep: p, includeDiff: true });
                await callTool(s => docs.registerDocumentationTools(s), 'get_file_history_code', { path: p });
            }
            assert.strictEqual(fs.existsSync(marker), false);
            const ok = await callTool(s => docs.registerDocumentationTools(s), 'get_file_history_code', { path: 'a.txt', format: 'text' });
            assert.match(ok.text, /first/, 'normal history still works');
        });

        test('get_blame_code (read-only scope) cannot run commands', async () => {
            const repo = makeRepo();
            const marker = path.join(repo, 'PWNED');
            const gitTools = proxyquire('../tools/git-tools', { '../utils/workspace': workspaceStub(repo) }) as { registerGitTools(s: McpServer): void };
            for (const p of payloads(marker)) {
                await callTool(s => gitTools.registerGitTools(s), 'get_blame_code', { path: p });
            }
            assert.strictEqual(fs.existsSync(marker), false);
            const ok = await callTool(s => gitTools.registerGitTools(s), 'get_blame_code', { path: 'a.txt' });
            assert.ok(!ok.isError, ok.text);
        });
    });

    suite('cluster routes are closed to relayed traffic', () => {
        let host: MCPServer;
        let port: number;
        suiteSetup(async () => {
            host = new MCPServer(0, '127.0.0.1');
            port = await host.listenOn(0, '127.0.0.1');
        });
        suiteTeardown(async () => {
            await host.closeListener();
        });
        const post = (p: string, headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
            const body = JSON.stringify({ tool: 'execute_shell_command_code', args: { command: 'echo hi' } });
            const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
            req.end(body);
        });
        test('/invoke and /__mcp_cluster/* answer 404 to funnel-like requests, even with a bearer', async () => {
            for (const p of [INVOKE_PATH, CLUSTER_REGISTER_PATH]) {
                assert.strictEqual(await post(p, { host: 'pc.tail1234.ts.net', authorization: 'Bearer anything' }), 404, `${p} public host`);
                assert.strictEqual(await post(p, { 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer anything' }), 404, `${p} XFF`);
                assert.strictEqual(await post(p, { 'tailscale-funnel-request': '?1' }), 404, `${p} tailscale header`);
            }
        });
        test('/invoke from this machine still needs the master credential', async () => {
            const status = await post(INVOKE_PATH, { authorization: 'Bearer mcpk_ro_not-the-master-key' });
            assert.ok(status === 401 || status === 503, `got ${status}`);
        });
    });

    test('security settings cannot be overridden by a project .vscode/settings.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const conf = pkg.contributes.configuration;
        const props: Record<string, { scope?: string }> = (Array.isArray(conf) ? conf : [conf]).reduce((acc: Record<string, unknown>, c: { properties: Record<string, unknown> }) => ({ ...acc, ...c.properties }), {});
        for (const key of ['port', 'host', 'auth.mode', 'auth.staticToken', 'auth.apiKey', 'auth.allowedOrigins', 'auth.allowNoOrigin',
            'security.sandbox.mode', 'security.sandbox.allowPaths', 'browser.confirm', 'browser.profile', 'browser.userDataDir',
            'browser.browserUrl', 'browser.executablePath', 'browser.allowFileUrls', 'browser.package', 'browser.command', 'browser.extraArgs']) {
            assert.strictEqual(props[`vscode-mcp-server.${key}`]?.scope, 'machine', key);
        }
    });
});
