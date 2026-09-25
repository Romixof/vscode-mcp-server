import * as assert from 'assert';
import * as vscode from 'vscode';
import { detectShellKind, resolveShellKind } from '../tools/shell-tools';

suite('shell detection against a real VS Code terminal', () => {
        let terminal: vscode.Terminal | undefined;

        suiteTeardown(() => {
                terminal?.dispose();
        });

        test('creationOptions is readable on a programmatically created terminal', async () => {
                terminal = vscode.window.createTerminal({
                        name: 'MCP Shell Commands',
                        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
                        cwd: undefined
                });
                const options = (terminal as unknown as { creationOptions?: { shellPath?: unknown } }).creationOptions;
                console.log(`  creationOptions present: ${options !== undefined}`);
                console.log(`  shellPath: ${JSON.stringify(options?.shellPath)}`);
                console.log(`  terminal.name: ${JSON.stringify(terminal.name)}`);
                assert.ok(options !== undefined, 'creationOptions must be readable');
        });

        test('a terminal created with a Git Bash shellPath is detected as bash', async () => {
                terminal = vscode.window.createTerminal({
                        name: 'MCP Shell Commands',
                        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
                });
                const detected = detectShellKind(terminal);
                console.log(`  detectShellKind: ${detected}`);
                assert.strictEqual(detected, 'bash', 'an explicit Git Bash shellPath must win over the Windows default');
        });

        test('a terminal created with a PowerShell shellPath is detected as powershell', async () => {
                const ps = vscode.window.createTerminal({
                        name: 'MCP Shell Commands',
                        shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
                });
                const detected = detectShellKind(ps);
                console.log(`  detectShellKind(powershell path): ${detected}`);
                ps.dispose();
                assert.strictEqual(detected, 'powershell');
        });

        test('the MCP terminal name alone never decides the shell', async () => {
                terminal = vscode.window.createTerminal({ name: 'MCP Shell Commands' });
                const options = (terminal as unknown as { creationOptions?: { shellPath?: unknown } }).creationOptions;
                console.log(`  default terminal shellPath: ${JSON.stringify(options?.shellPath)}`);
                const detected = detectShellKind(terminal);
                console.log(`  detectShellKind(default profile): ${detected}`);
                assert.ok(detected === 'bash' || detected === 'powershell');
        });

        test('resolveShellKind confirms a real bash terminal after probing', async function () {
                this.timeout(15000);
                terminal = vscode.window.createTerminal({
                        name: 'MCP Shell Commands',
                        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
                });
                const resolved = await resolveShellKind(terminal);
                console.log(`  resolveShellKind (live probe): ${resolved}`);
                assert.strictEqual(resolved, 'bash');
        });
});
