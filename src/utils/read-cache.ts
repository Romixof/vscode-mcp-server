export interface FileStatLike {
        size: number;
        mtime: number;
}

export interface ReadRecord {
        fingerprint: string;
        at: Date;
        chars: number;
        lines: number;
}

export type ReadCache = Map<string, ReadRecord>;

const CACHE_LIMIT = 256;

export function fileFingerprint(stat: FileStatLike): string {
        return `${stat.size}:${stat.mtime}`;
}

export function recentReads(): ReadCache {
        return new Map<string, ReadRecord>();
}

function remember(cache: ReadCache, key: string, record: ReadRecord): void {
        cache.delete(key);
        cache.set(key, record);
        while (cache.size > CACHE_LIMIT) {
                const oldest = cache.keys().next();
                if (oldest.done) {
                        return;
                }
                cache.delete(oldest.value);
        }
}

export interface RepeatSavings {
        refused: number;
        chars: number;
}

const savings: RepeatSavings = { refused: 0, chars: 0 };

export function repeatSavings(): RepeatSavings {
        return { ...savings };
}

function clockLabel(at: Date): string {
        const hh = String(at.getHours()).padStart(2, '0');
        const mm = String(at.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
}

function sectionKey(key: string, startLine: number, endLine: number): string {
        return `${key}#${startLine}:${endLine}`;
}

export function unchangedReadNotice(
        key: string,
        fingerprint: string,
        cache: ReadCache,
        startLine: number,
        endLine: number
): string | null {
        const whole = cache.get(key);
        const knownLines = whole && whole.fingerprint === fingerprint ? whole.lines : undefined;
        const asksForEverything = startLine <= 1
                && (endLine < 0 || (knownLines !== undefined && knownLines > 0 && endLine >= knownLines));

        if (asksForEverything) {
                if (whole && whole.fingerprint === fingerprint) {
                        savings.refused += 1;
                        savings.chars += whole.chars;
                        return [
                                `Unchanged since ${clockLabel(whole.at)} — ${whole.chars} characters in ${whole.lines} lines, already in your context.`,
                                `Not repeating it. startLine 1 with any endLine from ${whole.lines} upward is this same full read and is refused too; ask for the section you need, or delete this file from your working set.`
                        ].join(' ');
                }
                return null;
        }

        const section = cache.get(sectionKey(key, startLine, endLine));
        if (section && section.fingerprint === fingerprint) {
                savings.refused += 1;
                savings.chars += section.chars;
                return `Unchanged since ${clockLabel(section.at)} — lines ${startLine > 0 ? startLine : 1}${endLine > 0 ? ` to ${endLine}` : ''}, ${section.chars} characters, already in your context. Not repeating it.`;
        }

        return null;
}

export function recordRead(
        cache: ReadCache,
        key: string,
        fingerprint: string,
        chars: number,
        lines: number,
        startLine: number,
        endLine: number
): void {
        const record: ReadRecord = { fingerprint, at: new Date(), chars, lines };
        const coversWholeFile = startLine <= 1 && (endLine < 0 || (lines > 0 && endLine >= lines));
        remember(cache, coversWholeFile ? key : sectionKey(key, startLine, endLine), record);
}
