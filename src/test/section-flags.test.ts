import * as assert from 'assert';
import { fetchToolList, ListedTool } from './helpers/tool-list';

interface PropertyShape {
        description?: string;
        type?: string;
        enum?: string[];
        items?: { enum?: string[] };
}

async function schemaOf(name: string): Promise<Record<string, PropertyShape>> {
        const tools: ListedTool[] = await fetchToolList();
        const tool = tools.find(t => t.name === name);
        assert.ok(tool, `${name} must be registered`);
        return ((tool!.inputSchema && tool!.inputSchema.properties) || {}) as Record<string, PropertyShape>;
}

function enumOf(prop: PropertyShape | undefined): string[] | undefined {
        return prop && (prop.enum || (prop.items && prop.items.enum));
}

suite('section flags replaced the boolean fans', () => {
        test('session_bootstrap_code exposes one sections param, not four booleans', async () => {
                const props = await schemaOf('session_bootstrap_code');
                assert.deepStrictEqual(Object.keys(props).sort(), ['sections', 'workspace'], `unexpected shape: ${Object.keys(props).join(', ')}`);
                assert.deepStrictEqual(enumOf(props.sections), ['memory', 'guide', 'skills', 'layout'], 'the enum must name the four parts it replaced');
                assert.ok(/omit for all four/i.test(props.sections.description || ''), `the default must be stated: ${props.sections.description}`);
        });

        test('get_project_context_code exposes one sections param, not three booleans', async () => {
                const props = await schemaOf('get_project_context_code');
                assert.deepStrictEqual(
                        Object.keys(props).sort(),
                        ['depth', 'maxFileSize', 'sections', 'workspace'],
                        `unexpected shape: ${Object.keys(props).join(', ')}`
                );
                assert.deepStrictEqual(enumOf(props.sections), ['scripts', 'config', 'readme'], 'the enum must name the three parts it replaced');
                assert.ok(/omit for all three/i.test(props.sections.description || ''), `the default must be stated: ${props.sections.description}`);
        });

        test('includeDeps stays gone: it promised a filter that never ran', async () => {
                const props = await schemaOf('get_project_context_code');
                assert.ok(!('includeDeps' in props), 'includeDeps was declared but never read by the handler, so the dependencies summary is unconditional');
                for (const dead of ['includeScripts', 'includeConfigFiles', 'includeReadme']) {
                        assert.ok(!(dead in props), `${dead} moved into sections`);
                }
        });
});
