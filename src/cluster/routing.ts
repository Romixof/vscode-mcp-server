/**
 * Pure routing brain of the cluster: given a tool call's parsed arguments and a
 * snapshot of every folder open across all windows, decide which window should
 * execute the call. Deliberately dependency-free (no vscode import) so the
 * whole decision table unit-tests without a host.
 *
 * The golden rule mirrored from utils/workspace.ts: a "Name/relpath" path
 * resolves against Name even when the workspace parameter points elsewhere —
 * so routing precedence must match handler resolution precedence, or forwarded
 * calls would land on the wrong files.
 */
import { ClusterView, RoutedFolder, RouteDecision } from './types';

/** Checked in order; the first parameter that pins down an owning folder decides. */
export const LOCATION_PARAM_PRIORITY = ['path', 'filePath', 'sourcePath', 'targetPath', 'dir', 'cwd'];

/**
 * Tools whose meaning never depends on which window runs them. The aggregating
 * two compose their answers across the cluster themselves; the coffee ritual is
 * served wherever it was ordered.
 */
export const HUB_LOCAL_TOOLS = new Set([
	'brew_coffee_code',
	'get_server_info_code',
	'list_workspace_folders_code',
	'test_api_endpoint_code'
]);

/**
 * True when this call should fan out to every window instead of picking one.
 * Only whole-workspace diagnostics and symbol search qualify: both are read-only,
 * both run on window-local providers that no other window can reach, and silent
 * blind spots there would poison trust in the whole feature.
 */
export function broadcastEligible(tool: string, args: Record<string, unknown>): boolean {
	if (tool === 'search_symbols_code') {
		return true;
	}
	if (tool === 'get_diagnostics_code') {
		const p = args.path;
		return p === undefined || p === null || String(p).trim() === '';
	}
	return false;
}

function norm(s: string): string {
	return s.normalize('NFC').toLowerCase();
}

function foldCase(): boolean {
	return process.platform === 'win32';
}

/** Separator- and case-normalized form used for absolute prefix comparison. */
function absKey(fsPath: string): string {
	const slashed = fsPath.replace(/\\/g, '/');
	return foldCase() ? slashed.toLowerCase() : slashed;
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** Self-owned roots win ties; otherwise canonical (fsPath, windowId) order holds. */
function preferenceRank(f: RoutedFolder): number {
	return f.port === 0 ? 0 : 1;
}

function matchFolderByName(candidate: string, view: ClusterView): RoutedFolder | undefined {
	const wanted = norm(candidate);
	let hit: RoutedFolder | undefined;
	for (const f of view.folders) {
		if (norm(f.name) !== wanted && norm(f.label) !== wanted) {
			continue;
		}
		// Names collide across windows only when labels were deduped, and a
		// deduped label is unique by construction — the sole ambiguity is a
		// plain name claimed by several windows, resolved toward this window
		if (hit === undefined || preferenceRank(f) < preferenceRank(hit)) {
			hit = f;
		}
	}
	return hit;
}

function matchFolderByAbsPath(value: string, view: ClusterView): RoutedFolder | undefined {
	const key = absKey(value).replace(/\/+$/, '');
	let best: RoutedFolder | undefined;
	let bestLen = -1;
	for (const f of view.folders) {
		const rootKey = absKey(f.fsPath).replace(/\/+$/, '');
		const bounded = key === rootKey || key.startsWith(rootKey + '/');
		if (!bounded) {
			continue;
		}
		// Longest prefix wins so nested roots resolve to the innermost owner,
		// mirroring findOwningFolder's behavior inside a single window
		if (rootKey.length > bestLen || (rootKey.length === bestLen && best !== undefined && preferenceRank(f) < preferenceRank(best))) {
			best = f;
			bestLen = rootKey.length;
		}
	}
	return best;
}

function decisionFor(owner: RoutedFolder, args: Record<string, unknown>): RouteDecision {
	if (owner.port === 0) {
		return { kind: 'local', args };
	}
	return { kind: 'remote', windowId: owner.windowId, windowLabel: owner.windowLabel, port: owner.port, args };
}

/**
 * Turns every location-bearing parameter that references a cluster folder into
 * an absolute path. Absolute inputs resolve identically on whichever window
 * executes, which is what makes cross-folder moves/copies work even when the
 * source lives in one window and the target in another. Values matching nothing
 * keep their relative meaning against the executing window's default root.
 * The workspace parameter is handled separately: selectors take folder names,
 * not paths.
 */
export function absolutizeLocationParams(args: Record<string, unknown>, view: ClusterView): Record<string, unknown> {
	const out = { ...args };
	for (const param of LOCATION_PARAM_PRIORITY) {
		const v = out[param];
		if (typeof v !== 'string' || v.trim() === '') {
			continue;
		}
		const trimmed = v.trim();
		let owner: RoutedFolder | undefined;
		let rest = '';
		if (isAbsolutePath(trimmed)) {
			// Already machine-global; nothing to do
			continue;
		}
		const segments = trimmed.split(/[\\/]+/).filter(s => s !== '' && s !== '.');
		if (segments.length >= 1) {
			owner = matchFolderByName(segments[0], view);
			rest = segments.slice(1).join('/');
		}
		if (owner) {
			out[param] = rest ? `${owner.fsPath.replace(/\\/g, '/')}/${rest}` : owner.fsPath.replace(/\\/g, '/');
		}
	}
	return out;
}

export function resolveRoute(tool: string, args: Record<string, unknown>, view: ClusterView): RouteDecision {
	// Single-window fast path: not one byte of behavior may change when no
	// other window has ever joined
	if (!view.folders.some(f => f.port !== 0)) {
		return { kind: 'local' };
	}
	if (HUB_LOCAL_TOOLS.has(tool)) {
		return { kind: 'local' };
	}
	if (broadcastEligible(tool, args)) {
		return { kind: 'broadcast' };
	}

	// Location parameters come before the workspace selector because that is
	// how handlers resolve too: "Name/relpath" beats the workspace parameter
	for (const param of LOCATION_PARAM_PRIORITY) {
		const v = args[param];
		if (typeof v !== 'string' || v.trim() === '') {
			continue;
		}
		const trimmed = v.trim();
		if (isAbsolutePath(trimmed)) {
			const owner = matchFolderByAbsPath(trimmed, view);
			if (owner) {
				return decisionFor(owner, absolutizeLocationParams(args, view));
			}
			// Outside every root: fall through so lower-priority params get
			// their chance; ultimately this stays local, which keeps today's
			// outside-root semantics untouched
			continue;
		}
		const segments = trimmed.split(/[\\/]+/).filter(s => s !== '' && s !== '.');
		if (segments.length >= 1) {
			const owner = matchFolderByName(segments[0], view);
			if (owner) {
				return decisionFor(owner, absolutizeLocationParams(args, view));
			}
		}
	}

	// Explicit workspace selector, checked after paths exactly like the handlers do
	const ws = args.workspace;
	if (typeof ws === 'string' && ws.trim() !== '') {
		const trimmedWs = ws.trim();
		let owner: RoutedFolder | undefined;
		if (/^\d+$/.test(trimmedWs)) {
			// Global 1-based numbering across all windows, in view order
			const idx = parseInt(trimmedWs, 10);
			if (idx >= 1 && idx <= view.folders.length) {
				owner = view.folders[idx - 1];
			}
		} else {
			owner = matchFolderByName(trimmedWs, view);
		}
		if (owner) {
			// Rewrite the selector to the owner's local folder name: global
			// indexes mean nothing to a window's own resolver, and this applies
			// to self-routed calls just the same once spokes exist
			const rewritten = { ...args, workspace: owner.name };
			return decisionFor(owner, absolutizeLocationParams(rewritten, view));
		}
		// Unknown selector: execute locally so the handler raises its familiar
		// "Unknown workspace ..." message listing what this window knows
	}

	return { kind: 'local' };
}
