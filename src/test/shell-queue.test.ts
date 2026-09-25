import * as assert from 'assert';
import { executeShellCommand, queueOnTerminal } from '../tools/shell-tools';

type FakeTerminal = Parameters<typeof executeShellCommand>[0];

interface FakeExecution {
        output: string;
        exitCode: number;
}

function fakeTerminal(executions: FakeExecution[], gate?: { opened: () => void }): FakeTerminal {
        let index = 0;
        const terminal = {
                name: 'MCP',
                creationOptions: { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
                exitStatus: undefined,
                show(): void {},
                shellIntegration: {
                        executeCommand(): { read(): AsyncIterable<string> } {
                                const current = executions[index++];
                                const run = async function* (): AsyncGenerator<string> {
                                        gate?.opened();
                                        if (current.output.length > 0) {
                                                yield `${current.output}\n`;
                                        }
                                        yield '__MCP_EXIT:0\n';
                                };
                                return { read: run };
                        }
                }
        };
        return terminal as unknown as FakeTerminal;
}

suite('shell queue admission', () => {
        test('a call is rejected when the queue wait plus its timeout exceeds the client budget', async () => {
                const gate = { opened: () => {} };
                let openedResolve: () => void = () => {};
                const opened = new Promise<void>(r => { openedResolve = r; });
                gate.opened = () => openedResolve();
                const terminal = fakeTerminal([{ output: 'first', exitCode: 0 }], gate);

                const first = executeShellCommand(terminal, 'echo first', undefined, 5000);
                await opened;

                await assert.rejects(
                        () => executeShellCommand(terminal, 'echo second', undefined, 30000),
                        /background_task_code/,
                        'a call that cannot finish inside the client budget must be rejected, not silently queued'
                );

                await first;
        });

        test('the rejection names background_task_code and the busy terminal', async () => {
                const gate = { opened: () => {} };
                let openedResolve: () => void = () => {};
                const opened = new Promise<void>(r => { openedResolve = r; });
                gate.opened = () => openedResolve();
                const terminal = fakeTerminal([{ output: 'first', exitCode: 0 }], gate);

                const first = executeShellCommand(terminal, 'echo first', undefined, 5000);
                await opened;

                await assert.rejects(
                        () => executeShellCommand(terminal, 'echo second', undefined, 30000),
                        (err: unknown) => {
                                const message = err instanceof Error ? err.message : String(err);
                                assert.ok(message.includes('background_task_code'), `missing background_task_code: ${message}`);
                                assert.ok(/busy/i.test(message), `missing busy-terminal explanation: ${message}`);
                                return true;
                        }
                );

                await first;
        });

        test('a short call behind a short wait still runs', async () => {
                const gate = { opened: () => {} };
                let openedResolve: () => void = () => {};
                const opened = new Promise<void>(r => { openedResolve = r; });
                gate.opened = () => openedResolve();
                const terminal = fakeTerminal([
                        { output: 'first', exitCode: 0 },
                        { output: 'second', exitCode: 0 }
                ], gate);

                const first = executeShellCommand(terminal, 'echo first', undefined, 5000);
                await opened;
                const second = executeShellCommand(terminal, 'echo second', undefined, 2000);

                const firstResult = await first;
                const secondResult = await second;
                assert.strictEqual(firstResult.exitCode, 0);
                assert.strictEqual(secondResult.exitCode, 0);
                assert.ok(secondResult.output.includes('second'), `second call output lost: ${secondResult.output}`);
        });

        test('a call to a free terminal is never rejected', async () => {
                const terminal = fakeTerminal([{ output: 'solo', exitCode: 0 }]);
                const result = await executeShellCommand(terminal, 'echo solo', undefined, 2000);
                assert.strictEqual(result.exitCode, 0);
                assert.ok(result.output.includes('solo'));
        });

        test('the queue keeps running after a rejected call', async () => {
                const gate = { opened: () => {} };
                let openedResolve: () => void = () => {};
                const opened = new Promise<void>(r => { openedResolve = r; });
                gate.opened = () => openedResolve();
                const terminal = fakeTerminal([
                        { output: 'first', exitCode: 0 },
                        { output: 'third', exitCode: 0 }
                ], gate);

                const first = executeShellCommand(terminal, 'echo first', undefined, 5000);
                await opened;
                await assert.rejects(() => executeShellCommand(terminal, 'echo second', undefined, 30000));
                const third = await executeShellCommand(terminal, 'echo third', undefined, 2000);
                await first;

                assert.strictEqual(third.exitCode, 0, 'a rejected call must not poison the queue tail');
                assert.ok(third.output.includes('third'));
        });

        test('queueOnTerminal still serializes concurrent tasks', async () => {
                const terminal = fakeTerminal([]);
                const order: string[] = [];
                const make = (label: string, ms: number) => () => new Promise<void>(resolve => {
                        order.push(`start:${label}`);
                        setTimeout(() => {
                                order.push(`end:${label}`);
                                resolve();
                        }, ms);
                });

                await Promise.all([
                        queueOnTerminal(terminal, make('a', 40)),
                        queueOnTerminal(terminal, make('b', 5))
                ]);

                assert.deepStrictEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'], 'tasks overlapped on one terminal');
        });
});
