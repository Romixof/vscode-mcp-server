import * as assert from 'assert';
import { executeShellCommand, waitForShellIntegration, resolveShellTerminal } from '../tools/shell-tools';

type FakeTerminal = Parameters<typeof executeShellCommand>[0];

function liveTerminal(): FakeTerminal {
        return {
                name: 'MCP Shell Commands',
                creationOptions: { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
                exitStatus: undefined,
                show(): void {},
                shellIntegration: undefined
        } as unknown as FakeTerminal;
}

function deadTerminal(): FakeTerminal {
        return {
                name: 'MCP Shell Commands',
                creationOptions: { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
                exitStatus: { code: 1 },
                show(): void {},
                shellIntegration: undefined
        } as unknown as FakeTerminal;
}

suite('terminal recovery', () => {
        test('a dead terminal is detected without waiting', async () => {
                const started = Date.now();
                const ready = await waitForShellIntegration(deadTerminal(), 5000);
                const elapsed = Date.now() - started;
                assert.strictEqual(ready, false, 'a dead terminal can never become ready');
                assert.ok(elapsed < 1000, `waited ${elapsed}ms on a terminal that was already dead`);
        });

        test('a live terminal without integration yet is still awaited', async () => {
                const terminal = liveTerminal();
                const listeners: Array<(e: { terminal: unknown }) => void> = [];
                const originalWindow = (await import('vscode')).window;
                const hadIntegrationListener = 'onDidChangeTerminalShellIntegration' in originalWindow;
                (originalWindow as unknown as { onDidChangeTerminalShellIntegration: unknown }).onDidChangeTerminalShellIntegration = (cb: (e: { terminal: unknown }) => void) => {
                        listeners.push(cb);
                        return { dispose(): void {} };
                };
                setTimeout(() => {
                        (terminal as unknown as { shellIntegration: unknown }).shellIntegration = {};
                        for (const cb of listeners) {
                                cb({ terminal });
                        }
                }, 20);
                try {
                        const ready = await waitForShellIntegration(terminal, 1000);
                        assert.strictEqual(ready, true, 'a live terminal must still be waited for');
                } finally {
                        if (!hadIntegrationListener) {
                                delete (originalWindow as unknown as { onDidChangeTerminalShellIntegration?: unknown }).onDidChangeTerminalShellIntegration;
                        }
                }
        });

        test('a provider replaces a dead terminal', () => {
                const fresh = liveTerminal();
                const resolved = resolveShellTerminal(deadTerminal(), () => fresh);
                assert.strictEqual(resolved, fresh, 'the provider must supply a live terminal');
        });

        test('the provider wins even when the passed terminal looks alive', () => {
                const stale = liveTerminal();
                const fresh = liveTerminal();
                const resolved = resolveShellTerminal(stale, () => fresh);
                assert.strictEqual(resolved, fresh, 'the provider is the liveness authority');
        });

        test('without a provider the passed terminal is used as-is', () => {
                const terminal = liveTerminal();
                assert.strictEqual(resolveShellTerminal(terminal, undefined), terminal);
        });

        test('a dead terminal with no provider still resolves, so the caller can report it', () => {
                const terminal = deadTerminal();
                assert.strictEqual(resolveShellTerminal(terminal, undefined), terminal);
        });

        test('no terminal anywhere resolves to undefined', () => {
                assert.strictEqual(resolveShellTerminal(undefined, undefined), undefined);
        });
});
