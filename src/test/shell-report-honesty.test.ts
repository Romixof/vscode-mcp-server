import * as assert from 'assert';
import * as vscode from 'vscode';
import { describeShellKind, isShellKindVerified } from '../tools/shell-tools';

suite('shell reporting honesty', () => {
        test('a terminal with an explicit shellPath is reported as fact', () => {
                const terminal = vscode.window.createTerminal({
                        name: 'MCP Shell Commands',
                        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
                });
                try {
                        assert.strictEqual(isShellKindVerified(terminal), true);
                        assert.strictEqual(describeShellKind(terminal), 'bash', 'a known shell must be stated plainly');
                } finally {
                        terminal.dispose();
                }
        });

        test('a terminal with no creationOptions is reported as an assumption', () => {
                const terminal = vscode.window.createTerminal({ name: 'MCP Shell Commands' });
                try {
                        const options = (terminal as unknown as { creationOptions?: { shellPath?: unknown } }).creationOptions;
                        if (options?.shellPath !== undefined) {
                                return;
                        }
                        const described = describeShellKind(terminal);
                        assert.ok(
                                /assumed/.test(described),
                                `an unverified shell must be labelled as an assumption: ${described}`
                        );
                        assert.ok(/get_server_info_code/.test(described), 'the report must tell the model what to trust');
                } finally {
                        terminal.dispose();
                }
        });
});
