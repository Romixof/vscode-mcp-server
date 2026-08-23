import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Case-insensitive comparison form; NFC so macOS-stored NFD names still match
 * what clients type.
 */
function norm(s: string): string {
	return s.normalize('NFC').toLowerCase();
}

/**
 * Lists every root folder currently open in the window.
 */
export function listWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
	return vscode.workspace.workspaceFolders ?? [];
}

/**
 * Resolves one of the open workspace roots.
 * @param ref Optional folder name (case-insensitive) or 1-based index. Falls back to the first folder.
 */
export function resolveWorkspaceFolder(ref?: string): vscode.WorkspaceFolder {
	const folders = listWorkspaceFolders();
	if (folders.length === 0) {
		throw new Error('No workspace folder is open');
	}
	if (!ref || ref.trim() === '') {
		return folders[0];
	}
	const trimmed = ref.trim();
	// Names win over indexes: a folder literally called "1" must stay reachable
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

/**
 * Filesystem path of one of the open workspace roots (first folder by default).
 */
export function getWorkspaceRoot(ref?: string): string {
	return resolveWorkspaceFolder(ref).uri.fsPath;
}

/**
 * True when fsPath sits inside this folder. Normalizes separators before the
 * ".." check so entries whose basename starts with dots ("..tmp") are not
 * misclassified as outside.
 */
function containedIn(folder: vscode.WorkspaceFolder, fsPath: string): boolean {
	const relative = path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
	return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
}

/**
 * The open folder containing this uri — the innermost one when roots are
 * nested, matching vscode.workspace.getWorkspaceFolder — or undefined when it
 * sits outside every open root.
 */
export function findOwningFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
	const matches = listWorkspaceFolders().filter(f => containedIn(f, uri.fsPath));
	if (matches.length === 0) {
		return undefined;
	}
	return matches.reduce((a, b) => (b.uri.fsPath.length > a.uri.fsPath.length ? b : a));
}

/**
 * Turns a path-based tool input into a Uri. Absolute paths win. Otherwise,
 * with several folders open, a first segment matching an open folder's name
 * resolves against that folder so the "Name/relpath" strings this extension
 * displays round-trip as inputs. Anything else resolves against the selected
 * root.
 * @param input Path as shown by this extension, or an absolute path
 * @param ref Optional workspace root (name or 1-based index) for plain relative paths
 */
export function resolveInputPath(input: string, ref?: string): vscode.Uri {
	const trimmed = input.trim();
	if (path.isAbsolute(trimmed)) {
		return vscode.Uri.file(trimmed);
	}
	const folders = listWorkspaceFolders();
	if (folders.length > 1) {
		const segments = trimmed.split(/[\\/]+/).filter(s => s !== '' && s !== '.');
		if (segments.length > 0) {
			const owner = folders.find(f => norm(f.name) === norm(segments[0]));
			if (owner) {
				const rest = segments.slice(1).join('/');
				return rest ? vscode.Uri.joinPath(owner.uri, rest) : owner.uri;
			}
		}
	}
	return vscode.Uri.joinPath(resolveWorkspaceFolder(ref).uri, trimmed);
}

/**
 * Inverse of resolveInputPath, for tool output: a file inside an open root
 * reads as a plain relative path with one folder open and as "Name/relpath"
 * with several. Files outside every root stay absolute so the string still
 * feeds straight back into the path-based tools.
 */
export function workspaceDisplayPath(uri: vscode.Uri): string {
	const folders = listWorkspaceFolders();
	if (folders.length === 0) {
		return uri.fsPath;
	}
	const owner = findOwningFolder(uri);
	if (owner) {
		const relative = path.relative(owner.uri.fsPath, uri.fsPath);
		if (relative !== '') {
			return folders.length > 1 ? `${owner.name}/${relative}` : relative;
		}
	}
	if (folders.length > 1) {
		return uri.fsPath;
	}
	return path.relative(folders[0].uri.fsPath, uri.fsPath);
}

/**
 * Resolves a tool path input against the multi-root rules and splits the
 * result into what scanners and CLI wrappers need. Owned targets get the
 * owning root to run in plus a relative path; anything outside every root
 * stays absolute end to end, whatever the drive or UNC spelling.
 */
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
		displayPrefix: listWorkspaceFolders().length > 1 ? `${folder.name}/` : '',
		displayBase: listWorkspaceFolders().length > 1 ? `${folder.name}/` : '',
		owned: true
	};
}

/**
 * Shared zod-free description so every tool documents the param identically.
 */
export const WORKSPACE_PARAM_DESCRIPTION =
	'Which workspace root to use when multiple folders are open: folder name or 1-based index. Defaults to the first folder. A "Name/relpath" path resolves against Name even when this parameter points elsewhere.';
