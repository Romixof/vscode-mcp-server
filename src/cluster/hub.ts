/**
 * The hub's registry of joined windows: pure bookkeeping, no sockets. Label
 * assignment, lease sweeping and the canonical folder view used for routing
 * all live here so they can be exercised without a listener bound.
 */
import {
	FolderInfo,
	LEASE_MS,
	CLUSTER_PROTOCOL_VERSION,
	RegisterRequest,
	RegisterResponse,
	RoutedFolder,
	WindowInfo
} from './types';

interface SpokeRecord {
	windowId: string;
	label: string;
	port: number;
	folders: FolderInfo[];
	lastSeen: number;
	extensionVersion: string;
}

/**
 * Lowercases, NFC-normalizes and squashes everything non-alphanumeric so two
 * windows proposing "My Project!" and "my-project" collide visibly instead of
 * silently sharing a name.
 */
export function slugFolderName(raw: string): string {
	const slug = raw.normalize('NFC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
	return slug || 'window';
}

/** First free `name`, `name-2`, `name-3`, ... against the taken set. */
function uniquify(proposed: string, taken: Set<string>): string {
	if (!taken.has(proposed)) {
		return proposed;
	}
	for (let n = 2; ; n++) {
		const candidate = `${proposed}-${n}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

export class ClusterHub {
	private spokes = new Map<string, SpokeRecord>();
	private sweepTimer?: ReturnType<typeof setInterval>;

	constructor(
		/** This window's own folders, so spoke labels dedupe against them too. */
		private selfFoldersProvider: () => FolderInfo[],
		/** This window's own cluster label (its slugified first-folder name). */
		private selfLabel: string
	) { }

	startSweep(onEvict?: (evicted: SpokeRecord[]) => void): void {
		this.stopSweep();
		this.sweepTimer = setInterval(() => {
			const now = Date.now();
			const evicted: SpokeRecord[] = [];
			for (const [id, rec] of this.spokes) {
				if (now - rec.lastSeen > LEASE_MS) {
					this.spokes.delete(id);
					evicted.push(rec);
				}
			}
			if (evicted.length && onEvict) {
				onEvict(evicted);
			}
		}, LEASE_MS / 2);
		this.sweepTimer.unref?.();
	}

	stopSweep(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	get spokeCount(): number {
		return this.spokes.size;
	}

	getSpokes(): WindowInfo[] {
		return [...this.spokes.values()].map(rec => ({
			windowId: rec.windowId,
			label: rec.label,
			port: rec.port,
			folders: rec.folders.map(f => ({ ...f }))
		}));
	}

	/**
	 * Idempotent upsert keyed by windowId; re-registration (heartbeat with an
	 * unknown id, folder-set change) flows through here too.
	 */
	register(req: RegisterRequest): RegisterResponse {
		const selfFolders = this.selfFoldersProvider();
		const takenLabels = new Set<string>([this.selfLabel.toLowerCase()]);
		for (const f of selfFolders) {
			takenLabels.add(f.label.toLowerCase());
		}
		for (const rec of this.spokes.values()) {
			if (rec.windowId === req.windowId) {
				continue; // re-registration may reclaim its own labels
			}
			takenLabels.add(rec.label.toLowerCase());
			for (const f of rec.folders) {
				takenLabels.add(f.label.toLowerCase());
			}
		}
		// A window re-registering keeps its previously assigned labels stable
		const previous = this.spokes.get(req.windowId);

		const assignedName = previous?.label ?? uniquify(slugFolderName(req.proposedName), takenLabels);
		takenLabels.add(assignedName.toLowerCase());

		const labelOverrides: Record<string, string> = {};
		const folders: FolderInfo[] = req.folders.map(f => {
			const prior = previous?.folders.find(pf => pf.name === f.name);
			const label = prior?.label ?? uniquify(f.name, takenLabels);
			takenLabels.add(label.toLowerCase());
			if (label !== f.name) {
				labelOverrides[f.name] = label;
			}
			return { name: f.name, label, fsPath: f.fsPath };
		});

		this.spokes.set(req.windowId, {
			windowId: req.windowId,
			label: assignedName,
			port: req.port,
			folders,
			lastSeen: Date.now(),
			extensionVersion: req.extensionVersion
		});

		return { ok: true, assignedName, leaseMs: LEASE_MS, labelOverrides, windows: this.spokes.size + 1 };
	}

	/** Refreshes the lease and upserts the folder set; unknown ids are rejected so the spoke re-registers. */
	heartbeat(windowId: string, port: number, folders: Array<{ name: string; fsPath: string }>): { ok: true; leaseMs: number } | { ok: false; code: 'UNKNOWN_WINDOW' } {
		const rec = this.spokes.get(windowId);
		if (!rec) {
			return { ok: false, code: 'UNKNOWN_WINDOW' };
		}
		rec.lastSeen = Date.now();
		if (JSON.stringify(folders) !== JSON.stringify(rec.folders.map(f => ({ name: f.name, fsPath: f.fsPath })))) {
			// Folder set changed mid-session; relabel through the same path as registration
			this.register({
				role: 'spoke',
				protocol: CLUSTER_PROTOCOL_VERSION,
				extensionVersion: rec.extensionVersion,
				windowId,
				proposedName: rec.label,
				port,
				folders
			});
		} else {
			rec.port = port;
		}
		return { ok: true, leaseMs: LEASE_MS };
	}

	deregister(windowId: string): void {
		this.spokes.delete(windowId);
	}

	/**
	 * Snapshot for routing: self folders plus every spoke's, in canonical
	 * (normalized fsPath, windowId) order so global 1-based numbering is
	 * identical on every window regardless of join order.
	 */
	view(selfFolders: FolderInfo[], selfWindowId: string): RoutedFolder[] {
		const spokeEntries: RoutedFolder[] = [...this.spokes.values()].flatMap(rec =>
			rec.folders.map(f => ({
				name: f.name,
				label: f.label,
				fsPath: f.fsPath,
				windowId: rec.windowId,
				port: rec.port,
				windowLabel: rec.label
			}))
		);
		const entries: RoutedFolder[] = [
			...selfFolders.map(f => ({
				name: f.name,
				label: f.label,
				fsPath: f.fsPath,
				windowId: selfWindowId,
				port: 0,
				windowLabel: this.selfLabel
			})),
			...spokeEntries
		];
		return entries.sort((a, b) => {
			const ka = a.fsPath.replace(/\\/g, '/').toLowerCase();
			const kb = b.fsPath.replace(/\\/g, '/').toLowerCase();
			if (ka !== kb) {
				return ka < kb ? -1 : 1;
			}
			return a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0;
		});
	}
}