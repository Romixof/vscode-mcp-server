import * as assert from 'assert';
import { runtimeSection } from '../utils/runtime-facts';
import { buildFullCommand } from '../tools/shell-tools';

suite('runtime facts never overstate what was checked', () => {
        test('a missing python says where it was looked for', () => {
                const section = runtimeSection({ platform: 'win32', python: 'not on the extension host PATH' });
                assert.ok(
                        /not on the extension host PATH/.test(section),
                        `must name the scope of the failure, not claim python is absent: ${section}`
                );
                assert.ok(
                        !/^Interpreter: python not found/m.test(section),
                        'must not state a bare "not found" the terminal can contradict'
                );
        });

        test('a missing python tells the model how to find the real one', () => {
                const section = runtimeSection({ platform: 'win32', python: 'not on the extension host PATH' });
                assert.ok(/command -v python/.test(section), 'must give the shell command that resolves the truth');
        });

        test('a real python version is still reported plainly', () => {
                const section = runtimeSection({ platform: 'win32', python: '3.11.9', libs: { reportlab: true } });
                assert.ok(/Interpreter: python 3\.11\.9/.test(section), section);
        });
});

suite('shell cwd is deterministic', () => {
        function terminal(cwd: string): Parameters<typeof buildFullCommand>[0] {
                return {
                        name: 'MCP Shell Commands',
                        creationOptions: { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
                        exitStatus: undefined,
                        show(): void {},
                        shellIntegration: undefined
                } as unknown as Parameters<typeof buildFullCommand>[0];
        }

        test('an explicit cwd always emits a cd', () => {
                const command = buildFullCommand(terminal('x'), 'ls -la', 'synthese-limites');
                assert.ok(/^cd /.test(command), `a relative cwd must pin the directory: ${command}`);
        });

        test('a bare dot does not emit a cd, which is the bug', () => {
                const command = buildFullCommand(terminal('x'), 'ls -la', '.');
                assert.ok(!/^cd /.test(command), 'this is the shape that lets the terminal keep its old directory');
        });
});
