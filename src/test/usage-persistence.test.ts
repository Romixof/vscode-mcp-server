import * as assert from 'assert';
import type { Context } from 'mocha';
import { recordToolCall, setUsagePersistence, saveUsage, getUsageSnapshot, setRegisteredTools } from '../utils/usage';

function callsFor(tool: string): number | undefined {
        return getUsageSnapshot().find(u => u.tool === tool)?.calls;
}

suite('usage persistence', () => {
        teardown(() => {
                setUsagePersistence(undefined);
                setRegisteredTools([]);
        });

        test('stored counts merge into the live ones instead of replacing them', () => {
                setUsagePersistence({
                        load: () => ({ persist_alpha_code: 4, persist_garbage_code: 'x' as unknown as number }),
                        save: () => undefined
                });
                recordToolCall('persist_alpha_code');

                assert.strictEqual(callsFor('persist_alpha_code'), 5, 'a stored count must survive the reload and keep counting up');
                assert.strictEqual(callsFor('persist_garbage_code'), undefined, 'a non-numeric stored value must be dropped');
        });

        test('a reload that repeats the merge does not double the stored counts', () => {
                setUsagePersistence({ load: () => ({ persist_beta_code: 7 }), save: () => undefined });
                setUsagePersistence({ load: () => ({ persist_beta_code: 7 }), save: () => undefined });
                assert.strictEqual(callsFor('persist_beta_code'), 7, 'restoring twice must not add the stored value twice');
        });

        test('save receives the full counts map, whatever wired the store', async () => {
                let captured: Record<string, number> | undefined;
                setUsagePersistence({ load: () => undefined, save: counts => { captured = counts; } });
                recordToolCall('persist_gamma_code');
                recordToolCall('persist_gamma_code');
                await saveUsage();

                assert.ok(captured, 'saveUsage must hand the map to the wired store');
                assert.strictEqual(captured!.persist_gamma_code, 2, 'every call must be counted');
        });

        test('without a wired store, saving does nothing and does not throw', async () => {
                setUsagePersistence(undefined);
                recordToolCall('persist_delta_code');
                await assert.doesNotReject(() => saveUsage());
                assert.strictEqual(callsFor('persist_delta_code'), 1, 'counting works with or without persistence');
        });

        test('an async store is awaited before saveUsage resolves', async () => {
                let saved: Record<string, number> | undefined;
                setUsagePersistence({
                        load: () => undefined,
                        save: async counts => {
                                await new Promise(resolve => setTimeout(resolve, 10));
                                saved = counts;
                        }
                });
                recordToolCall('persist_async_code');
                await saveUsage();
                assert.ok(saved, 'deactivate awaits saveUsage, so the write must finish before the host can stop');
                assert.strictEqual(saved!.persist_async_code, 1);
        });

        test('a recorded call reaches the store while the session runs', async () => {
                const saved: Array<Record<string, number>> = [];
                setUsagePersistence({ load: () => undefined, save: counts => { saved.push(counts); } });
                recordToolCall('persist_live_code');
                await new Promise(resolve => setTimeout(resolve, 50));
                assert.ok(
                        saved.some(counts => counts.persist_live_code === 1),
                        `a write issued only at shutdown is lost when the window closes, so the session must persist as it runs: ${JSON.stringify(saved)}`
                );
        });

        test('a burst collapses into one write, and the trailing write carries every call', async function (this: Context) {
                this.timeout(8000);
                const saved: Array<Record<string, number>> = [];
                setUsagePersistence({ load: () => undefined, save: counts => { saved.push(counts); } });
                recordToolCall('persist_burst_code');
                recordToolCall('persist_burst_code');
                recordToolCall('persist_burst_code');
                await new Promise(resolve => setTimeout(resolve, 50));
                assert.strictEqual(saved.length, 1, `a burst must not write on every call: ${JSON.stringify(saved)}`);
                await new Promise(resolve => setTimeout(resolve, 2100));
                assert.strictEqual(saved.length, 2, `the throttled write must still happen: ${JSON.stringify(saved)}`);
                assert.strictEqual(saved[1].persist_burst_code, 3, 'throttling must delay the count, never drop it');
        });
});