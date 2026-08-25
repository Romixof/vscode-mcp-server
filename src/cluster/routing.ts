import { ClusterView, RoutedFolder, RouteDecision } from './types';

export const LOCATION_PARAM_PRIORITY = ['path', 'filePath', 'sourcePath', 'targetPath', 'dir', 'cwd'];

export const HUB_LOCAL_TOOLS = new Set([
	'brew_coffee_code',
	'get_server_info_code',
	'list_workspace_folders_code',
	'test_api_endpoint_code'
]);

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

function absKey(fsPath: string): string {
	const slashed = fsPath.replace(/\\/g, '/');
	return foldCase() ? slashed.toLowerCase() : slashed;
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

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

	if (!view.folders.some(f => f.port !== 0)) {
		return { kind: 'local' };
	}
	if (HUB_LOCAL_TOOLS.has(tool)) {
		return { kind: 'local' };
	}
	if (broadcastEligible(tool, args)) {
		return { kind: 'broadcast' };
	}

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

	const ws = args.workspace;
	if (typeof ws === 'string' && ws.trim() !== '') {
		const trimmedWs = ws.trim();
		let owner: RoutedFolder | undefined;
		if (/^\d+$/.test(trimmedWs)) {

			const idx = parseInt(trimmedWs, 10);
			if (idx >= 1 && idx <= view.folders.length) {
				owner = view.folders[idx - 1];
			}
		} else {
			owner = matchFolderByName(trimmedWs, view);
		}
		if (owner) {

			const rewritten = { ...args, workspace: owner.name };
			return decisionFor(owner, absolutizeLocationParams(rewritten, view));
		}

	}

	return { kind: 'local' };
}
