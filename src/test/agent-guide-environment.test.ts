import * as assert from 'assert';
import { environmentSection, resolveAgentInstructions, AGENT_INSTRUCTIONS_VERSION } from '../utils/agent-instructions';

suite('agent guide environment section', () => {
        test('the guide version was bumped so cached v8 sessions reload it', () => {
                assert.notStrictEqual(AGENT_INSTRUCTIONS_VERSION, '8', 'guide version must move off 8 once its content changes');
        });

        test('the Windows section names the interpreter that actually exists', () => {
                const section = environmentSection('win32');
                assert.ok(/`python`/.test(section), 'must tell the model python is the interpreter');
                assert.ok(/`python3` does not exist/.test(section), `must warn that python3 is absent: ${section}`);
        });

        test('the Windows section names the search tool that actually exists', () => {
                const section = environmentSection('win32');
                assert.ok(/grep/.test(section), 'must name grep');
                assert.ok(/`rg` is not installed/.test(section), `must warn ripgrep is absent: ${section}`);
        });

        test('the Windows section kills the fc-list hunt', () => {
                const section = environmentSection('win32');
                assert.ok(/fc-list/.test(section), 'must mention fc-list so the model stops trying it');
        });

        test('the Windows section states the real path shape', () => {
                const section = environmentSection('win32');
                assert.ok(/\/mnt\/|C:/.test(section), 'must warn that Linux and drive-letter paths are wrong here');
        });

        test('a non-Windows platform is not given Windows advice', () => {
                const linux = environmentSection('linux');
                assert.ok(!/fc-list/.test(linux), 'fc-list exists on Linux; do not claim it is missing');
                assert.ok(/python3/.test(linux), 'Linux should be told python3');
        });

        test('the default guide carries an environment section', () => {
                const guide = resolveAgentInstructions(undefined, 'win32');
                assert.ok(guide.includes('ENVIRONMENT'), 'the guide must carry an ENVIRONMENT section');
                assert.ok(guide.includes('python3'), 'the win32 environment facts must be present');
        });

        test('an override still gets the machine facts appended', () => {
                const guide = resolveAgentInstructions('MY CUSTOM GUIDE', 'win32');
                assert.ok(guide.startsWith('MY CUSTOM GUIDE'), 'the override must stay first');
                assert.ok(guide.includes('ENVIRONMENT'), 'machine facts are true regardless of the override');
        });

        test('the environment section stays short enough to be free', () => {
                const section = environmentSection('win32');
                assert.ok(section.length < 700, `environment section is ${section.length} chars; keep it under 700`);
        });
});
