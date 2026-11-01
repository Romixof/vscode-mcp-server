import { z } from 'zod';

/**
 * Argument repair for the bootstrap relay.
 *
 * Models routinely guess argument names from other tools: `query` for a
 * search pattern, `include` for a glob, `newText` for replacement content.
 * The MCP SDK strips unknown keys silently, so a guessed `include` vanished
 * and a search meant for one file scanned the whole workspace. The relay now
 * (1) renames keys that only differ by case, `_` or `-`, (2) maps common
 * synonyms onto the target's real parameter, and (3) refuses any key that is
 * still unknown, naming the valid ones, instead of dropping it.
 */

/** Synonym -> canonical parameter names to try, in order. */
const SYNONYMS: Record<string, string[]> = {
        query: ['pattern'],
        search: ['pattern', 'old_string'],
        regex: ['pattern'],
        term: ['pattern'],
        include: ['glob'],
        includes: ['glob'],
        includepattern: ['glob'],
        filepattern: ['glob'],
        files: ['glob'],
        filter: ['glob'],
        file: ['path'],
        filepath: ['path'],
        filename: ['path'],
        uri: ['path'],
        dir: ['path'],
        directory: ['path'],
        folder: ['path'],
        start: ['startLine'],
        from: ['startLine'],
        fromline: ['startLine'],
        line: ['startLine'],
        end: ['endLine'],
        to: ['endLine'],
        toline: ['endLine'],
        newtext: ['new_string', 'content'],
        newcontent: ['new_string', 'content'],
        newcode: ['new_string', 'content'],
        newstring: ['content'],
        content: ['new_string'],
        originalcode: ['old_string'],
        oldstring: ['originalCode'],
        replacement: ['new_string', 'content'],
        replace: ['new_string', 'content'],
        text: ['content', 'new_string'],
        code: ['content'],
        oldtext: ['old_string', 'originalCode'],
        oldcontent: ['old_string', 'originalCode'],
        oldcode: ['old_string', 'originalCode'],
        original: ['originalCode', 'old_string'],
        find: ['old_string', 'pattern'],
        replaceall: ['replace_all'],
        matchcase: ['caseSensitive'],
        limit: ['maxResults'],
        max: ['maxResults'],
};

/** Keys that switch regex matching; the search tools always take a regex. */
const REGEX_FLAGS = new Set(['isregex', 'useregex', 'regexp']);

const squash = (key: string): string => key.toLowerCase().replace(/[_\-\s]/g, '');

function escapeRegex(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Top-level keys of a tool's input schema, or undefined when not an object schema. */
export function schemaKeys(schema: unknown): string[] | undefined {
        const s = schema as z.ZodTypeAny | undefined;
        if (s && s instanceof z.ZodObject) {
                return Object.keys(s.shape);
        }
        return undefined;
}

export interface NormalizedArgs {
        args: Record<string, unknown>;
        /** "include -> glob" style notes, shown to the model so it learns the real names. */
        renamed: string[];
        /** Keys the tool does not take, after every rename was tried. */
        unknown: string[];
}

export function normalizeRelayArgs(raw: Record<string, unknown> | undefined, keys: string[]): NormalizedArgs {
        const input = raw ?? {};
        const out: Record<string, unknown> = {};
        const renamed: string[] = [];
        const unknown: string[] = [];
        const known = new Set(keys);
        const bySquash = new Map(keys.map(k => [squash(k), k]));
        let literalPattern = false;

        // Exact names first, so a synonym never overwrites a real argument.
        for (const [key, value] of Object.entries(input)) {
                if (known.has(key)) {
                        out[key] = value;
                }
        }
        for (const [key, value] of Object.entries(input)) {
                if (known.has(key)) {
                        continue;
                }
                const sq = squash(key);
                if (REGEX_FLAGS.has(sq) && !bySquash.has(sq) && known.has('pattern')) {
                        literalPattern = value === false || value === 'false';
                        renamed.push(`${key} dropped (pattern is always a regex${literalPattern ? '; your literal text was escaped' : ''})`);
                        continue;
                }
                const candidates = [bySquash.get(sq), ...(SYNONYMS[sq] ?? [])].filter((k): k is string => !!k);
                const target = candidates.find(k => known.has(k) && !(k in out));
                if (target) {
                        out[target] = value;
                        renamed.push(`${key} -> ${target}`);
                } else {
                        unknown.push(key);
                }
        }
        // Line numbers sent as firstLine/lastLine (observed live): they belong
        // in startLine/endLine; the anchors are text.
        for (const [anchor, line] of [['firstLine', 'startLine'], ['lastLine', 'endLine']] as const) {
                const value = out[anchor];
                const asNumber = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : undefined);
                if (asNumber !== undefined && known.has(line)) {
                        delete out[anchor];
                        if (out[line] === undefined) {
                                out[line] = asNumber;
                                renamed.push(`${anchor}=${asNumber} -> ${line} (${anchor} is the text the line starts with)`);
                        } else {
                                renamed.push(`${anchor}=${asNumber} dropped (${anchor} is the text the line starts with)`);
                        }
                }
        }
        if (literalPattern && typeof out.pattern === 'string') {
                out.pattern = escapeRegex(out.pattern);
        }
        return { args: out, renamed, unknown };
}
