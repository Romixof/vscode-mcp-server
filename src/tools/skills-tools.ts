import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { executeShellCommand } from './shell-tools';

const DEFAULT_SKILLS_ROOT = '.claude/skills';
const DEFAULT_EXCLUDES = ['*.bak', '.DS_Store', 'node_modules/*', '__pycache__/*'];

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugify(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

interface Frontmatter {
    data: Record<string, string>;
    raw: string;
    end: number;
}

function parseFrontmatter(content: string): Frontmatter | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
        return null;
    }
    const raw = match[1];
    const data: Record<string, string> = {};
    let currentKey: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) {
            currentKey = kv[1];
            data[currentKey] = kv[2].trim().replace(/^"(.*)"$/, '$1');
        } else if (currentKey && /^\s+\S/.test(line)) {
            data[currentKey] += ' ' + line.trim();
        }
    }
    return { data, raw, end: match[0].length };
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    return vscode.workspace.fs.stat(uri).then(() => true, () => false);
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
}

export function registerSkillsTools(server: McpServer): void {

    server.tool('list_skills_code', `Lists every agent skill found under a root folder, by recursively finding each SKILL.md and reading its frontmatter (name, description).

WHEN TO USE: Getting an overview of installed skills before deciding whether to reuse, extend, or create a new one. Faster and more reliable than browsing folders by hand — especially once a skill has annex files (scripts, templates) sitting next to it that would otherwise clutter a plain file listing.

Read-only. Never executes any code found inside a skill.`, {
        root: z.string().optional().default(DEFAULT_SKILLS_ROOT).describe(`Folder to scan for SKILL.md files, relative to the workspace root (or absolute). Defaults to "${DEFAULT_SKILLS_ROOT}".`),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ root = DEFAULT_SKILLS_ROOT, workspace }) => {
        try {
            const rootUri = resolveInputPath(root, workspace);
            if (!(await pathExists(rootUri))) {
                return { content: [{ type: 'text', text: `No such folder: "${root}".` }] };
            }

            const found: Array<{ relPath: string; name?: string; description?: string }> = [];

            async function walk(dirUri: vscode.Uri): Promise<void> {
                let entries: [string, vscode.FileType][];
                try {
                    entries = await vscode.workspace.fs.readDirectory(dirUri);
                } catch {
                    return;
                }
                for (const [name, type] of entries) {
                    const childUri = vscode.Uri.joinPath(dirUri, name);
                    if (type & vscode.FileType.Directory) {
                        await walk(childUri);
                    } else if (name === 'SKILL.md') {
                        const content = await readTextFile(childUri);
                        const fm = parseFrontmatter(content);
                        found.push({
                            relPath: path.relative(rootUri.fsPath, childUri.fsPath).replace(/\\/g, '/'),
                            name: fm?.data.name,
                            description: fm?.data.description
                        });
                    }
                }
            }

            await walk(rootUri);

            if (found.length === 0) {
                return { content: [{ type: 'text', text: `No SKILL.md found under "${root}".` }] };
            }

            found.sort((a, b) => a.relPath.localeCompare(b.relPath));
            const lines = found.map(s => {
                const desc = s.description
                    ? (s.description.length > 220 ? s.description.slice(0, 220) + '…' : s.description)
                    : '(no description in frontmatter)';
                return `- **${s.name || '(unnamed)'}** — \`${s.relPath}\`\n  ${desc}`;
            });

            return {
                content: [{
                    type: 'text',
                    text: `${found.length} skill(s) found under "${root}":\n\n${lines.join('\n\n')}`
                }]
            };
        } catch (error) {
            console.error('[list_skills_code] Error:', error);
            throw error;
        }
    });

    server.tool('validate_skill_code', `Validates a SKILL.md: checks frontmatter completeness, balanced code fences, that referenced sibling files actually exist next to it, and does a non-executing syntax check of embedded JavaScript blocks.

WHEN TO USE: Before deploying, committing, or packaging a skill — especially right after editing embedded code blocks or splitting a skill into annex files. Catches the class of mistake that only surfaces once an agent actually tries to use the skill: a missing required frontmatter field, an unbalanced \`\`\` fence, a referenced .py/.html annex that was never created, or broken JS inside a \`\`\`javascript block or <script> tag.

Read-only. Python blocks are NOT syntax-checked (no Python interpreter is assumed to be on PATH) — only reported if referenced-but-missing as a file.`, {
        path: z.string().describe('Path to a SKILL.md file, or to the folder that directly contains it'),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ path: inputPath, workspace }) => {
        try {
            let target = resolveInputPath(inputPath, workspace);
            let stat = await vscode.workspace.fs.stat(target).then(undefined, () => undefined);
            if (!stat) {
                return { content: [{ type: 'text', text: `Path not found: "${inputPath}".` }], isError: true };
            }
            if (stat.type & vscode.FileType.Directory) {
                target = vscode.Uri.joinPath(target, 'SKILL.md');
                stat = await vscode.workspace.fs.stat(target).then(undefined, () => undefined);
                if (!stat) {
                    return { content: [{ type: 'text', text: `No SKILL.md inside "${inputPath}".` }], isError: true };
                }
            }

            const content = await readTextFile(target);
            const dirUri = vscode.Uri.joinPath(target, '..');

            const errors: string[] = [];
            const warnings: string[] = [];

            const fm = parseFrontmatter(content);
            if (!fm) {
                errors.push('No YAML frontmatter found — file must start with a "---" ... "---" block.');
            } else {
                if (!fm.data.name) { errors.push('Frontmatter is missing the required "name" field.'); }
                if (!fm.data.description) {
                    errors.push('Frontmatter is missing the required "description" field.');
                } else if (fm.data.description.length < 40) {
                    warnings.push('Description is quite short — skills are matched on description text, a terse one may under-trigger.');
                }
            }

            const fenceCount = (content.match(/```/g) || []).length;
            if (fenceCount % 2 !== 0) {
                errors.push(`Unbalanced code fences: ${fenceCount} \`\`\` markers found (should be an even number).`);
            }

            const refRegex = /`(\.?\/?[\w-]+\.(?:py|js|ts|html|htm|json|csv|txt|sh))`/g;
            const referenced = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = refRegex.exec(content)) !== null) {
                referenced.add(m[1].replace(/^\.\//, ''));
            }
            for (const ref of referenced) {
                if (ref.includes('/')) { continue; }
                const exists = await pathExists(vscode.Uri.joinPath(dirUri, ref));
                if (!exists) {
                    warnings.push(`References "${ref}" but no such file exists next to SKILL.md.`);
                }
            }

            const jsBlocks = [...content.matchAll(/```(?:javascript|js)\r?\n([\s\S]*?)```/g)].map(x => x[1]);
            const scriptTags = [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
            let jsIndex = 0;
            for (const js of [...jsBlocks, ...scriptTags]) {
                jsIndex++;
                try {
                    new Function(js);
                } catch (e) {
                    errors.push(`Embedded JS block #${jsIndex}: ${(e as Error).message}`);
                }
            }

            const status = errors.length === 0 ? '✅ VALID' : '❌ INVALID';
            const sections = [`${status} — ${path.basename(target.fsPath)}`];
            if (errors.length) {
                sections.push(`\nErrors (${errors.length}):\n${errors.map(e => `  - ${e}`).join('\n')}`);
            }
            if (warnings.length) {
                sections.push(`\nWarnings (${warnings.length}):\n${warnings.map(w => `  - ${w}`).join('\n')}`);
            }
            if (!errors.length && !warnings.length) {
                sections.push('\nNo issues detected.');
            }

            return { content: [{ type: 'text', text: sections.join('\n') }] };
        } catch (error) {
            console.error('[validate_skill_code] Error:', error);
            throw error;
        }
    });

    server.tool('package_skill_code', `Packages a skill folder into a .zip archive via the system "zip" command — ready to share or install elsewhere.

WHEN TO USE: Once a skill folder (SKILL.md plus any annex scripts/templates) is finalized, to produce a distributable archive in one call instead of "mkdir + cp + zip" by hand. Excludes common cruft (*.bak, .DS_Store, node_modules/*, __pycache__/*) by default.

Requires the "zip" CLI on PATH; returns a clear error otherwise rather than failing silently.`, {
        skillPath: z.string().describe('Path to the skill folder to package (the one directly containing SKILL.md)'),
        outputPath: z.string().optional().describe('Destination .zip path. Defaults to "<skill-folder-name>.zip" next to the skill folder.'),
        exclude: z.array(z.string()).optional().describe('Extra glob patterns to exclude, in addition to the defaults (*.bak, .DS_Store, node_modules/*, __pycache__/*).'),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ skillPath, outputPath, exclude = [], workspace }) => {
        try {
            const dirUri = resolveInputPath(skillPath, workspace);
            const dirStat = await vscode.workspace.fs.stat(dirUri).then(undefined, () => undefined);
            if (!dirStat || !(dirStat.type & vscode.FileType.Directory)) {
                return { content: [{ type: 'text', text: `Not a folder: "${skillPath}".` }], isError: true };
            }
            if (!(await pathExists(vscode.Uri.joinPath(dirUri, 'SKILL.md')))) {
                return { content: [{ type: 'text', text: `"${skillPath}" has no SKILL.md — refusing to package (wrong folder?).` }], isError: true };
            }

            const folderName = path.basename(dirUri.fsPath);
            const parentDir = path.dirname(dirUri.fsPath);
            const finalOutput = outputPath
                ? resolveInputPath(outputPath, workspace).fsPath
                : path.join(parentDir, `${folderName}.zip`);

            const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('MCP Skills');

            const zipCheck = await executeShellCommand(terminal, 'zip -v', parentDir, 5000)
                .catch(() => ({ output: '', exitCode: 1 }));
            if (zipCheck.exitCode !== 0) {
                return {
                    content: [{ type: 'text', text: 'The "zip" command is not available on PATH — install it (e.g. "apt install zip" / "brew install zip") or package the folder manually.' }],
                    isError: true
                };
            }

            const excludeArgs = [...DEFAULT_EXCLUDES, ...exclude]
                .map(pattern => `-x ${shellSingleQuote(pattern)}`)
                .join(' ');
            const cmd = `zip -r ${shellSingleQuote(finalOutput)} ${shellSingleQuote(folderName)} ${excludeArgs}`;
            const result = await executeShellCommand(terminal, cmd, parentDir, 30000);

            if (result.exitCode !== 0) {
                return { content: [{ type: 'text', text: `zip failed:\n${result.output}` }], isError: true };
            }

            return { content: [{ type: 'text', text: `Skill packaged: ${finalOutput}\n\n${result.output}` }] };
        } catch (error) {
            console.error('[package_skill_code] Error:', error);
            throw error;
        }
    });

    server.tool('create_skill_code', `Scaffolds a new skill: creates "<root>/<slug>/SKILL.md" with a valid YAML frontmatter and a minimal section skeleton.

WHEN TO USE: Starting a brand-new skill from scratch, so the frontmatter is well-formed from the first line instead of hand-typing it and risking a malformed block. Does not overwrite an existing skill unless overwrite=true.`, {
        name: z.string().describe('Human-readable skill name — used in the frontmatter "name" field and to derive the folder slug'),
        description: z.string().describe('One-line description used for skill matching/triggering — be specific about when an agent should reach for this skill'),
        root: z.string().optional().default(DEFAULT_SKILLS_ROOT).describe(`Folder the skill is created under. Defaults to "${DEFAULT_SKILLS_ROOT}".`),
        overwrite: z.boolean().optional().default(false).describe('Overwrite an existing SKILL.md at that path instead of refusing'),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION)
    }, async ({ name, description, root = DEFAULT_SKILLS_ROOT, overwrite = false, workspace }) => {
        try {
            const slug = slugify(name);
            if (!slug) {
                throw new Error(`Skill name "${name}" produces an empty slug — use letters or digits.`);
            }

            const rootUri = resolveInputPath(root, workspace);
            const skillDirUri = vscode.Uri.joinPath(rootUri, slug);
            const skillMdUri = vscode.Uri.joinPath(skillDirUri, 'SKILL.md');

            if ((await pathExists(skillMdUri)) && !overwrite) {
                return {
                    content: [{ type: 'text', text: `"${slug}/SKILL.md" already exists — pass overwrite=true to replace it.` }],
                    isError: true
                };
            }

            const escapedDescription = description.replace(/"/g, '\\"');
            const scaffold = `---
name: ${slug}
description: "${escapedDescription}"
---

# ${name}

## When to use this skill
<!-- Describe the concrete triggers: phrases, file types, situations. -->

## Steps
1. ...
2. ...
`;

            await vscode.workspace.fs.createDirectory(skillDirUri);
            await vscode.workspace.fs.writeFile(skillMdUri, Buffer.from(scaffold, 'utf-8'));

            return {
                content: [{
                    type: 'text',
                    text: `Skill scaffolded at "${path.join(root, slug, 'SKILL.md')}". Edit it to fill in the actual instructions.`
                }]
            };
        } catch (error) {
            console.error('[create_skill_code] Error:', error);
            throw error;
        }
    });
}
