import * as assert from 'assert';
import { AGENT_INSTRUCTIONS_VERSION, DEFAULT_AGENT_INSTRUCTIONS } from '../utils/agent-instructions';
import { TOOL_HINTS } from '../utils/tool-annotations';
import { scopeAllows, toolsWithoutScopeMapping, ALL_SCOPES } from '../auth/scopes';

const guide = DEFAULT_AGENT_INSTRUCTIONS;
const NEW_TOOLS = ['edit_file_code', 'get_active_editor_code', 'list_open_tabs_code'];

suite('agent guide', () => {
        test('the tool count in the guide matches the registry', () => {
                const registered = Object.keys(TOOL_HINTS).length;
                const claimed = Number((guide.match(/TOOL INDEX \((\d+) tools/) ?? [])[1]);
                assert.ok(claimed > 0, 'the full guide must state its card count in the TOOL INDEX header');
                assert.strictEqual(claimed, registered, `guide claims ${claimed}, registry has ${registered}`);
        });

        test('tells the model that its callable tool list may be partial', () => {
                assert.ok(
                        /lookup_tool_code\(query/i.test(guide),
                        'guide does not route a missing tool through lookup_tool_code'
                );
                assert.ok(
                        /IS callable by name/i.test(guide),
                        'guide does not state that an indexed tool is callable even when unlisted'
                );
                assert.ok(
                        /without trying/i.test(guide),
                        'guide does not forbid claiming a tool unavailable without trying'
                );
                assert.ok(
                        /never silently skip/i.test(guide),
                        'guide does not forbid silently dropping the step'
                );
                assert.ok(
                        !/name it in your reply/i.test(guide),
                        'the old \'name it and carry on\' advice must not come back: a live session proved the model stops there'
                );
        });

        test('teaches the bootstrap relay for clients that list one tool only', () => {
                assert.ok(
                        /session_bootstrap_code\(action="call", tool="<name>", args=\{\.\.\.\}\)/.test(guide),
                        'guide does not teach the relay invocation shape'
                );
                assert.ok(
                        /session_bootstrap_code\(action="call", tool="lookup_tool_code"/.test(guide),
                        'guide does not show how to fetch a card through the relay'
                );
                assert.ok(
                        /bootstrap relay/i.test(guide),
                        'guide does not name the mechanism the relay answers'
                );
        });

        test('carries a version tag', () => {
                assert.ok(/^\d+$/.test(AGENT_INSTRUCTIONS_VERSION), `version looks wrong: ${AGENT_INSTRUCTIONS_VERSION}`);
        });

        test('documents every new tool', () => {
                for (const tool of NEW_TOOLS) {
                        assert.ok(guide.includes(tool), `guide never mentions ${tool}`);
                }
        });

        test('routes edits to edit_file_code and demotes replace_lines_code', () => {
                const workflow = guide.slice(0, guide.indexOf('detailed cards'));
                assert.ok(workflow.includes('edit_file_code'), 'workflow does not name edit_file_code');
                assert.ok(
                        !/Edit with replace_lines_code/.test(workflow),
                        'workflow still tells the model to lead with replace_lines_code'
                );
        });

        test('tells the model how to resolve the ambiguous-edit case', () => {
                assert.ok(
                        /more than once|2\+ matches|multiple|refuses ambiguity/i.test(guide),
                        'guide does not explain what to do when old_string is ambiguous'
                );
        });

        test('points at the editor tools for "this" and "here"', () => {
                assert.ok(guide.includes('get_active_editor_code'), 'no mention of get_active_editor_code');
                assert.ok(guide.includes('list_open_tabs_code'), 'no mention of list_open_tabs_code');
        });

        test('every new tool is scope-mapped', () => {
                assert.deepStrictEqual(toolsWithoutScopeMapping(NEW_TOOLS), [], 'new tool is unmapped');
        });

        test('a read-only key can call the editor tools but not edit_file_code', () => {
                assert.ok(scopeAllows(['fs:read'], 'get_active_editor_code'), 'editor read denied to read-only key');
                assert.ok(scopeAllows(['fs:read'], 'list_open_tabs_code'), 'tab list denied to read-only key');
                assert.ok(!scopeAllows(['fs:read'], 'edit_file_code'), 'edit_file_code reachable by a read-only key');
                assert.ok(scopeAllows(ALL_SCOPES, 'edit_file_code'), 'edit_file_code denied to a full key');
        });
});
