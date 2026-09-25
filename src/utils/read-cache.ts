export interface FileStatLike {
        size: number;
        mtime: number;
}

export interface ReadRecord {
        fingerprint: string;
        at: Date;
        chars: number;
}

export type ReadCache = Map<string, ReadRecord>;

export function fileFingerprint(stat: FileStatLike): string {
        return `${stat.size}:${stat.mtime}`;
}

export function recentReads(): ReadCache {
        return new Map<string, ReadRecord>();
}

function clockLabel(at: Date): string {
        const hh = String(at.getHours()).padStart(2, '0');
        const mm = String(at.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
}

export function unchangedReadNotice(
        key: string,
        fingerprint: string,
        cache: ReadCache,
        startLine: number,
        endLine: number
): string | null {
        if (startLine > 0 || endLine > 0) {
                return null;
        }
        const prior = cache.get(key);
        if (!prior || prior.fingerprint !== fingerprint) {
                return null;
        }
        return [
                `Unchanged since ${clockLabel(prior.at)} — ${prior.chars} characters, already in your context.`,
                'Not repeating it. Read a line range (startLine/endLine) for a section, or delete this file from your working set if you no longer need it.'
        ].join(' ');
}

export function recordRead(cache: ReadCache, key: string, fingerprint: string, chars: number): void {
        cache.set(key, { fingerprint, at: new Date(), chars });
}
