import * as assert from 'assert';
import * as http from 'http';
import * as https from 'https';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const RAW = 'https://raw.githubusercontent.com/Romixof/vscode-mcp-server/master';

function head(url: string, redirects = 3): Promise<{ status: number; type: string; bytes: number } | null> {
        return new Promise((resolve, reject) => {
                const agent = url.startsWith('https:') ? https : http;
                const req = agent.get(url, { method: 'HEAD', timeout: 15000 }, res => {
                        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                                res.resume();
                                head(res.headers.location, redirects - 1).then(resolve, reject);
                                return;
                        }
                        const len = Number(res.headers['content-length'] ?? '0');
                        res.resume();
                        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), bytes: len });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
        });
}

describe('MCP server metadata', () => {
        let serverInfo: { title?: string; icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>; websiteUrl?: string; description?: string } | undefined;

        before(async () => {
                const server = new McpServer({
                        name: 'vscode-mcp-server',
                        version: '0.20.0',
                        title: 'VSCodium MCP Server',
                        description: 'Turn VS Code into an MCP server.',
                        websiteUrl: 'https://github.com/Romixof/vscode-mcp-server',
                        icons: [
                                { src: `${RAW}/media/icon-256.png`, mimeType: 'image/png', sizes: ['256x256'], theme: 'dark' as const },
                                { src: `${RAW}/media/logo.svg`, mimeType: 'image/svg+xml', theme: 'dark' as const }
                        ]
                }, { capabilities: { logging: {}, tools: { listChanged: false } } });
                server.tool('probe_code', 'probe', {}, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: 'metadata-test', version: '1.0.0' }, { capabilities: {} });
                await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
                serverInfo = client.getServerVersion() as typeof serverInfo;
                await client.close();
                await server.close();
        });

        it('carries a human title in the initialize response', () => {
                assert.strictEqual(serverInfo?.title, 'VSCodium MCP Server');
        });

        it('carries a websiteUrl', () => {
                assert.strictEqual(serverInfo?.websiteUrl, 'https://github.com/Romixof/vscode-mcp-server');
        });

        it('carries a description', () => {
                assert.ok((serverInfo?.description ?? '').length > 0);
        });

        it('advertises at least one icon', () => {
                assert.ok(Array.isArray(serverInfo?.icons));
                assert.ok((serverInfo?.icons?.length ?? 0) >= 1);
        });

        it('uses absolute https URLs so a cloud client can fetch them', () => {
                for (const icon of serverInfo?.icons ?? []) {
                        assert.ok(icon.src.startsWith('https://'), `not https: ${icon.src}`);
                }
        });

        it('declares a mimeType for every icon', () => {
                for (const icon of serverInfo?.icons ?? []) {
                        assert.ok(icon.mimeType && icon.mimeType.length > 0, `missing mimeType: ${icon.src}`);
                }
        });

        it('declares sizes only on the raster icon, matching the file', () => {
                const png = (serverInfo?.icons ?? []).find(i => i.mimeType === 'image/png');
                assert.deepStrictEqual(png?.sizes, ['256x256']);
        });

        it('serves the advertised PNG from the repository', async function () {
                this.timeout(30000);
                const icon = (serverInfo?.icons ?? []).find(i => i.mimeType === 'image/png');
                assert.ok(icon, 'no png icon advertised');
                const res = await head(icon!.src);
                assert.ok(res !== null, 'icon URL unreachable');
                assert.strictEqual(res!.status, 200);
                assert.ok(res!.type.includes('image/png'), `content-type was ${res!.type}`);
        });

        it('serves the advertised SVG from the repository', async function () {
                this.timeout(30000);
                const icon = (serverInfo?.icons ?? []).find(i => i.mimeType === 'image/svg+xml');
                assert.ok(icon, 'no svg icon advertised');
                const res = await head(icon!.src);
                assert.ok(res !== null, 'icon URL unreachable');
                assert.strictEqual(res!.status, 200);
        });
});
