import * as assert from 'assert';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerAdvancedTools } from '../tools/advanced-tools';
import { detectShellKind } from '../tools/shell-tools';

type TerminalArg = Parameters<typeof detectShellKind>[0];

function fakeTerminal(shellPath: string): TerminalArg {
        return {
                name: 'MCP',
                creationOptions: { shellPath },
                exitStatus: undefined,
                show(): void {},
                shellIntegration: undefined
        } as unknown as TerminalArg;
}

type HandlerResult = { content?: Array<{ type: string; text?: string }> };
type ToolHandler = () => Promise<HandlerResult>;

function captureHandler(shellInfo?: () => string | undefined): () => Promise<{ text: string }> {
        let captured: ToolHandler | undefined;
        const probe = {
                tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
                        if (name === 'get_server_info_code') {
                                captured = handler;
                        }
                }
        } as unknown as McpServer;

        registerAdvancedTools(probe, { host: '127.0.0.1', port: 3400 }, undefined, undefined, shellInfo);
        assert.ok(captured, 'get_server_info_code handler was not registered');
        return async () => {
                const result = await (captured as ToolHandler)();
                return { text: (result.content ?? []).map(c => c.text ?? '').join('\n') };
        };
}

suite('server info shell report', () => {
        test('server info reports a bash terminal', async () => {
                const terminal = fakeTerminal('C:\\Program Files\\Git\\bin\\bash.exe');
                const call = captureHandler(() => detectShellKind(terminal));
                const { text } = await call();
                assert.ok(/- Shell: bash$/m.test(text), `expected a bash Shell line, got:\n${text}`);
        });

        test('server info reports a PowerShell terminal', async () => {
                const terminal = fakeTerminal('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
                const call = captureHandler(() => detectShellKind(terminal));
                const { text } = await call();
                assert.ok(/- Shell: powershell$/m.test(text), `expected a powershell Shell line, got:\n${text}`);
        });

        test('the reported shell matches the detector', async () => {
                const terminal = fakeTerminal('C:\\Program Files\\Git\\bin\\bash.exe');
                const call = captureHandler(() => detectShellKind(terminal));
                const { text } = await call();
                assert.ok(text.includes(`- Shell: ${detectShellKind(terminal)}`), `report disagrees with the detector:\n${text}`);
        });

        test('the Shell line sits next to the existing Platform line', async () => {
                const terminal = fakeTerminal('C:\\Program Files\\Git\\bin\\bash.exe');
                const call = captureHandler(() => detectShellKind(terminal));
                const { text } = await call();
                assert.ok(/- Platform: /m.test(text), 'Platform line disappeared');
                assert.ok(/- Shell: /m.test(text), 'Shell line missing');
        });

        test('registration still succeeds with no accessor at all', async () => {
                const call = captureHandler(undefined);
                const { text } = await call();
                assert.ok(text.length > 0, 'server info returned nothing without an accessor');
                assert.ok(/- Shell: unknown$/m.test(text), `expected an explicit unknown Shell line:\n${text}`);
        });
});
