import * as vscode from 'vscode';
import * as path from 'path';

function norm(s: string): string {
	return s.normalize('NFC').toLowerCase();
}

let clusterDisplayActive = false;
let clusterLabelOverrides = new Map<string, string>();

export function setClusterDisplay(active: boolean, overrides?: Record<string, string>): void {
	clusterDisplayActive = active;
	clusterLabelOverrides = new Map();
	if (overrides) {
		for (const [local, label] of Object.entries(overrides)) {
			if (local !== label) {
				clusterLabelOverrides.set(norm(local), label);
			}
		}
	}
}

export function isInCluster(): boolean {
	return clusterDisplayActive;
}

export function displayLabelFor(folder: vscode.WorkspaceFolder): string {
	return clusterLabelOverrides.get(norm(folder.name)) ?? folder.name;
}

export function listWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
	return vscode.workspace.workspaceFolders ?? [];
}

export function prefixDisplay(): boolean {
	return listWorkspaceFolders().length > 1 || clusterDisplayActive;
}

export function resolveWorkspaceFolder(ref?: string): vscode.WorkspaceFolder {
	const folders = listWorkspaceFolders();
	if (folders.length === 0) {
		throw new Error('No workspace folder is open');
	}
	if (!ref || ref.trim() === '') {
		return folders[0];
	}
	const trimmed = ref.trim();

	const byName = folders.find(f => norm(f.name) === norm(trimmed));
	if (byName) {
		return byName;
	}
	if (/^\d+$/.test(trimmed)) {
		const index = parseInt(trimmed, 10);
		if (index >= 1 && index <= folders.length) {
			return folders[index - 1];
		}
	}
	throw new Error(
		`Unknown workspace "${trimmed}". Open workspaces: ${folders
			.map((f, i) => `${i + 1}=${f.name}`)
			.join(', ')}`
	);
}

export function getWorkspaceRoot(ref?: string): string {
	return resolveWorkspaceFolder(ref).uri.fsPath;
}

function containedIn(folder: vscode.WorkspaceFolder, fsPath: string): boolean {
	const relative = path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
	return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
}

export function findOwningFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
	const matches = listWorkspaceFolders().filter(f => containedIn(f, uri.fsPath));
	if (matches.length === 0) {
		return undefined;
	}
	return matches.reduce((a, b) => (b.uri.fsPath.length > a.uri.fsPath.length ? b : a));
}

export function resolveInputPath(input: string, ref?: string): vscode.Uri {
	const trimmed = input.trim();
	if (path.isAbsolute(trimmed)) {
		return vscode.Uri.file(trimmed);
	}
	const folders = listWorkspaceFolders();
	if (prefixDisplay()) {
		const segments = trimmed.split(/[\\/]+/).filter(s => s !== '' && s !== '.');
		if (segments.length > 0) {

			const owner = folders.find(
				f => norm(f.name) === norm(segments[0]) || norm(displayLabelFor(f)) === norm(segments[0])
			);
			if (owner) {
				const rest = segments.slice(1).join('/');
				return rest ? vscode.Uri.joinPath(owner.uri, rest) : owner.uri;
			}
		}
	}
	return vscode.Uri.joinPath(resolveWorkspaceFolder(ref).uri, trimmed);
}

export function workspaceDisplayPath(uri: vscode.Uri): string {
	const folders = listWorkspaceFolders();
	if (folders.length === 0) {
		return uri.fsPath;
	}
	const owner = findOwningFolder(uri);
	if (owner) {
		const relative = path.relative(owner.uri.fsPath, uri.fsPath);
		if (relative !== '') {
			return prefixDisplay() ? `${displayLabelFor(owner)}/${relative}` : relative;
		}
	}
	if (prefixDisplay()) {
		return uri.fsPath;
	}
	return path.relative(folders[0].uri.fsPath, uri.fsPath);
}

export function resolveRelativeToolPath(
	input: string,
	ref?: string
): {
	root: string;
	relative: string;
	fsPath: string;
	dir: string;
	gitPath: string;
	displayPrefix: string;
	displayBase: string;
	owned: boolean;
} {
	const uri = resolveInputPath(input, ref);
	const folder = findOwningFolder(uri);
	if (!folder) {
		return {
			root: getWorkspaceRoot(ref),
			relative: '',
			fsPath: uri.fsPath,
			dir: uri.fsPath,
			gitPath: uri.fsPath,
			displayPrefix: '',
			displayBase: uri.fsPath.replace(/\\/g, '/') + '/',
			owned: false
		};
	}
	const root = folder.uri.fsPath;
	const relativeNative = path.relative(root, uri.fsPath);
	return {
		root,
		relative: relativeNative.replace(/\\/g, '/'),
		fsPath: uri.fsPath,
		dir: path.join(root, relativeNative),

		gitPath: relativeNative.replace(/\\/g, '/'),
		displayPrefix: prefixDisplay() ? `${displayLabelFor(folder)}/` : '',
		displayBase: prefixDisplay() ? `${displayLabelFor(folder)}/` : '',
		owned: true
	};
}

export const WORKSPACE_PARAM_DESCRIPTION =
	'Which workspace root to use when multiple folders are open: folder name or 1-based index. Defaults to the first folder. A "Name/relpath" path resolves against Name even when this parameter points elsewhere. With several VS Code windows sharing this server, names and indexes span every window — list_workspace_folders_code is authoritative.';
