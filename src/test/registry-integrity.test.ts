import * as assert from 'assert';
import * as path from 'path';
import { scopeAllows, toolsWithoutScopeMapping, ALL_SCOPES, unregisteredToolNames } from '../auth/scopes';
import { TOOL_HINTS } from '../utils/tool-annotations';

function collectRegisteredTools(rootDir: string): string[] {
        const fs = require('fs');
        const names = new Set<string>();
        const walk = (dir: string): void => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const p = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                                if (entry.name !== 'test') { walk(p); }
                        } else if (entry.name.endsWith('.ts')) {
                                const src = fs.readFileSync(p, 'utf8');
                                for (const m of src.matchAll(/server\.tool\(\s*\n?\s*'([a-z_]+_code)'/g)) { names.add(m[1]); }
                                for (const m of src.matchAll(/server\.tool\(\s*'([a-z_]+_code)'/g)) { names.add(m[1]); }
                        }
                }
        };
        walk(rootDir);
        return [...names].sort();
}

suite('tool registry integrity', () => {
        const registered = collectRegisteredTools(path.join(__dirname, '..', '..', 'src'));

        test('registers the expected number of tools', () => {
                console.log(`  registered: ${registered.length}`);
                assert.ok(registered.length >= 88, `only ${registered.length} tools registered`);
        });

        test('every registered tool is scope-mapped', () => {
                const unmapped = toolsWithoutScopeMapping(registered);
                console.log(`  unmapped: ${unmapped.length === 0 ? 'none' : unmapped.join(', ')}`);
                assert.deepStrictEqual(unmapped, [], `denied for every key: ${unmapped.join(', ')}`);
        });

        test('no scope entry points at a missing tool', () => {
                const known = new Set(registered);
                const orphans = unregisteredToolNames().filter(n => !known.has(n));
                assert.deepStrictEqual(orphans, [], `orphans: ${orphans.join(', ')}`);
        });

        test('every registered tool is annotated', () => {
                const missing = registered.filter(n => !TOOL_HINTS[n]);
                assert.deepStrictEqual(missing, [], `unannotated: ${missing.join(', ')}`);
        });

        test('a full-scope key can reach every read-only tool', () => {
                const denied = registered.filter(n => TOOL_HINTS[n]?.readOnlyHint && !scopeAllows(ALL_SCOPES, n));
                assert.deepStrictEqual(denied, [], `read-only denied: ${denied.join(', ')}`);
        });
});
