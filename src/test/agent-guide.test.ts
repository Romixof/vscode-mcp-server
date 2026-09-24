import * as assert from 'assert';
import { AGENT_INSTRUCTIONS_VERSION, DEFAULT_AGENT_INSTRUCTIONS } from '../utils/agent-instructions';
import { TOOL_HINTS } from '../utils/tool-annotations';
import { scopeAllows, toolsWithoutScopeMapping, ALL_SCOPES } from '../auth/scopes';

const guide = DEFAULT_AGENT_INSTRUCTIONS;
const NEW_TOOLS = ['edit_file_code', 'get_active_editor_code', 'list_open_tabs_code'];

suite('agent guide', () => {
        test('the tool count in the guide matches the registry', () => {
                const registered = Object.keys(TOOL_HINTS).length;
                const claimed = Number((guide.match(/FULL TOOL CATALOG \((\d+) tools\)/) ?? [])[1]);
                assert.strictEqual(claimed, registered, `guide claims ${claimed}, registry has ${registered}`);
                console.log(`  guide count ${claimed} matches registry`);
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
                const workflow = guide.slice(0, guide.indexOf('FULL TOOL CATALOG'));
                assert.ok(workflow.includes('edit_file_code'), 'workflow does not name edit_file_code');
                assert.ok(
                        !/Edit with replace_lines_code/.test(workflow),
                        'workflow still tells the model to lead with replace_lines_code'
                );
        });

        test('tells the model how to resolve the ambiguous-edit case', () => {
                assert.ok(
                        /more than once|2\+ matches|multiple/i.test(guide),
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
