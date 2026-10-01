import * as assert from 'assert';
import * as path from 'path';

suite('shipped bundle', () => {
        test('the bundle loads in the extension host and exports the activation hooks', () => {
                const bundle = path.join(__dirname, '..', '..', 'dist', 'extension.js');
                const loaded = require(bundle) as { activate?: unknown; deactivate?: unknown };
                assert.strictEqual(typeof loaded.activate, 'function', `the bundle must export activate: ${bundle}`);
                assert.strictEqual(typeof loaded.deactivate, 'function', `the bundle must export deactivate: ${bundle}`);
        });
});