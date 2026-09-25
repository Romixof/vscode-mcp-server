import * as assert from 'assert';
import { executeShellCommand, detectShellKind } from '../tools/shell-tools';

type FakeTerminal = Parameters<typeof executeShellCommand>[0];

interface Step {
        out: string;
        exitCode: number;
        marker?: boolean;
}

function fakeTerminal(steps: Step[], shellPath = 'C:\\Program Files\\Git\\bin\\bash.exe'): { terminal: FakeTerminal; executed: string[] } {
        let index = 0;
        const executed: string[] = [];
        const terminal = {
                name: 'MCP',
                creationOptions: { shellPath },
                exitStatus: undefined,
                show(): void {},
                shellIntegration: {
                        executeCommand(command: string): { read(): AsyncIterable<string> } {
                                executed.push(command);
                                const current = steps[index++] ?? { out: '', exitCode: 0 };
                                const run = async function* (): AsyncGenerator<string> {
                                        yield `${current.out}\n`;
                                        if (current.marker !== false) {
                                                yield `__MCP_EXIT:${current.exitCode}\n`;
                                        }
                                };
                                return { read: run };
                        }
                }
        };
        return { terminal: terminal as unknown as FakeTerminal, executed };
}

suite('shell kind authority', () => {
        test('a Git Bash terminal with PowerShell syntax is retried and sticks to bash', async () => {
                const { terminal, executed } = fakeTerminal([
                        { out: 'bash: line 1: syntax error near unexpected token', exitCode: 2, marker: false },
                        { out: 'done', exitCode: 0 }
                ]);
                const result = await executeShellCommand(terminal, 'Get-ChildItem', undefined, 2000);
                assert.strictEqual(executed.length, 2, 'a genuine wrap mismatch should retry once');
                assert.ok(result.output.includes('done'), 'the successful retry should win');
                assert.strictEqual(detectShellKind(terminal), 'bash', 'shellPath is authoritative and says bash');
        });

        test('a failed retry must not override the explicit shellPath', async () => {
                const { terminal } = fakeTerminal([
                        { out: 'bash: line 1: syntax error near unexpected token', exitCode: 2, marker: false },
                        { out: 'bash: line 1: syntax error near unexpected token', exitCode: 2, marker: false },
                        { out: 'plain output', exitCode: 0 }
                ]);
                await executeShellCommand(terminal, 'Get-ChildItem', undefined, 2000);
                assert.strictEqual(
                        detectShellKind(terminal),
                        'bash',
                        'a doubly-failed retry pinned the terminal away from its explicit shellPath'
                );
                const second = await executeShellCommand(terminal, 'echo plain', undefined, 2000);
                assert.strictEqual(second.exitCode, 0, `later command failed: exit ${second.exitCode}`);
        });

        test('a missing binary is a normal failure, never a wrap mismatch', async () => {
                const { terminal, executed } = fakeTerminal([
                        { out: 'bash: rg: command not found', exitCode: 127, marker: false },
                        { out: 'should never run', exitCode: 0 }
                ]);
                await executeShellCommand(terminal, 'rg -i inter | head -40', undefined, 2000);
                assert.strictEqual(executed.length, 1, `a missing binary triggered a retry. Executed ${executed.length}x`);
                assert.strictEqual(detectShellKind(terminal), 'bash');
        });

        test('a PowerShell terminal with bash syntax is retried and sticks to powershell', async () => {
                const { terminal } = fakeTerminal([
                        { out: 'The term \'ls\' is not recognized as the name of a cmdlet', exitCode: 1, marker: false },
                        { out: 'done', exitCode: 0 }
                ], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
                await executeShellCommand(terminal, 'ls -la', undefined, 2000);
                assert.strictEqual(
                        detectShellKind(terminal),
                        'powershell',
                        'shellPath is authoritative and says powershell'
                );
        });
});
