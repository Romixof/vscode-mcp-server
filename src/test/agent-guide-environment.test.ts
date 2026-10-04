import * as assert from 'assert';
import { environmentSection, resolveAgentInstructions, AGENT_INSTRUCTIONS_VERSION } from '../utils/agent-instructions';

suite('agent guide environment section', () => {
        test('the guide version moved past the last published one', () => {
                const minimum = 10;
                assert.ok(
                        Number(AGENT_INSTRUCTIONS_VERSION) >= minimum,
                        `guide version is ${AGENT_INSTRUCTIONS_VERSION}, must be >= ${minimum} — bump it whenever the content changes`
                );
        });

        test('the Windows section names the interpreter convention without claiming to probe', () => {
                const section = environmentSection('win32');
                assert.ok(/`python`/.test(section), 'must tell the model python is the interpreter');
                assert.ok(/`python3`/.test(section), `must warn that python3 is the wrong name: ${section}`);
                assert.ok(
                        /get_server_info_code/.test(section),
                        `the section must point at the tool that measures the interpreter: ${section}`
                );
        });

        test('the Windows section names the search tool without claiming to know what is installed', () => {
                const section = environmentSection('win32');
                assert.ok(/grep/.test(section), 'must name grep');
                assert.ok(
                        !/`rg` is not installed/.test(section),
                        `nothing probes ripgrep, so the section must not assert it is absent: ${section}`
                );
        });

        test('the section never claims to have measured this machine', () => {
                for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
                        const section = environmentSection(platform);
                        assert.ok(
                                !/checked when the guide loads/.test(section),
                                `the section is a fixed string per platform, not a measurement: ${section}`
                        );
                }
        });

        test('the section ships no developer path', () => {
                for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
                        const section = environmentSection(platform);
                        assert.ok(
                                !/d:\/Mammouth|\/d\/Mammouth/i.test(section),
                                `a marketplace guide must not name the author's folders: ${section}`
                        );
                }
        });

        test('the Windows section kills the fc-list hunt', () => {
                const section = environmentSection('win32');
                assert.ok(/fc-list/.test(section), 'must mention fc-list so the model stops trying it');
        });

        test('the guide never hardcodes which shell is running', () => {
                const section = environmentSection('win32');
                assert.ok(
                        !/Terminal is Git Bash/.test(section),
                        `the guide must not assert a shell it cannot verify: ${section}`
                );
                assert.ok(/get_server_info_code/.test(section), 'the guide must point at the authoritative shell source');
        });

        test('the Windows section states the path shape without naming a folder', () => {
                const section = environmentSection('win32');
                assert.ok(/\/mnt\//.test(section), 'must warn that Linux paths are wrong here');
                assert.ok(/C:/.test(section), 'must warn that a drive-letter path is wrong in the integrated bash');
                assert.ok(
                        !/[a-z]:\/[a-z0-9]/i.test(section),
                        `the section must describe a path shape, never a real folder: ${section}`
                );
        });

        test('a non-Windows platform is not given Windows advice', () => {
                const linux = environmentSection('linux');
                assert.ok(!/fc-list/.test(linux), 'fc-list exists on Linux; do not claim it is missing');
                assert.ok(/python3/.test(linux), 'Linux should be told python3');
        });

        test('the default guide carries the environment section for its platform', () => {
                const guide = resolveAgentInstructions(undefined, 'win32');
                assert.ok(guide.includes('ENVIRONMENT'), 'the guide must carry an ENVIRONMENT section');
                assert.ok(
                        /`python` or `py`/.test(guide),
                        `the win32 interpreter advice must survive into the guide: ${environmentSection('win32')}`
                );
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
