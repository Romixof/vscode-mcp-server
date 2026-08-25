import * as path from 'path';

/**
 * F-SANDBOX — filesystem confinement for every authenticated tool call.
 *
 * Design goals:
 *  1. Uncontournable: the check lives in resolveSandboxedPath, which every
 *     file-touching tool already funnels through. A tool that bypasses it
 *     would have to stop using the shared workspace utils entirely.
 *  2. Symlink-proof: the final accessed path is resolved with realpath
 *     semantics before comparison, so a symlink planted inside the
 *     workspace pointing at C:\Windows cannot smuggle reads out.
 *  3. Explicit over silent: a blocked access returns a typed error that
 *     names the sandbox root, instead of a generic ENOENT.
 */

export type SandboxMode = 'workspace' | 'home' | 'full';

export interface SandboxConfig {
	mode: SandboxMode;
	/** Extra roots allowed in workspace mode (absolute paths). */
	allowPaths: string[];
	/** Home directory for 'home' mode. */
	homeDir?: string;
}

export class SandboxViolationError extends Error {
	readonly attempted: string;
	readonly root: string;
	constructor(attempted: string, root: string) {
		super(`Path is outside the allowed sandbox (${root}): ${attempted}`);
		this.name = 'SandboxViolationError';
		this.attempted = attempted;
		this.root = root;
	}
}

/** Normalize to a comparison key: absolute, forward slashes, no trailing sep. */
function normalizeForCompare(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isSubpath(root: string, target: string): boolean {
	const r = normalizeForCompare(root);
	const t = normalizeForCompare(target);
	if (!r) return true;
	return t === r || t.startsWith(r + '/');
}

/**
 * Compute the list of allowed roots from config + open workspace folders.
 * Called fresh on every check so settings changes apply immediately.
 */
export function computeAllowedRoots(
	config: SandboxConfig,
	workspaceFolders: Array<{ fsPath: string }>
): string[] {
	const roots: string[] = [];
	switch (config.mode) {
		case 'full':
			return []; // empty = everything allowed
		case 'home':
			if (config.homeDir) roots.push(config.homeDir);
			break;
		case 'workspace':
		default:
			for (const f of workspaceFolders) {
				roots.push(f.fsPath);
			}
			for (const p of config.allowPaths) {
				roots.push(p);
			}
			break;
	}
	// dedupe + keep only truthy
	const seen = new Set<string>();
	return roots.filter(r => {
		if (!r) return false;
		const k = normalizeForCompare(r);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/**
 * Validate that targetPath is inside one of the allowed roots.
 *
 * realTarget: the realpath-resolved version of the target if it exists on
 * disk (symlinks resolved). Callers should pass undefined for files that do
 * not exist yet (create_file); existing-file checks use the resolved form so
 * a symlink escape cannot slip through.
 *
 * Throws SandboxViolationError when outside every root.
 */
export function assertInSandbox(
	targetPath: string,
	realTarget: string | undefined,
	config: SandboxConfig,
	workspaceFolders: Array<{ fsPath: string }>,
	toolName: string
): void {
	const roots = computeAllowedRoots(config, workspaceFolders);
	if (roots.length === 0) return; // full mode

	const candidates = [targetPath];
	if (realTarget && realTarget !== targetPath) candidates.push(realTarget);

	for (const candidate of candidates) {
		let ok = false;
		for (const root of roots) {
			if (isSubpath(root, candidate)) { ok = true; break; }
		}
		if (!ok) {
			throw new SandboxViolationError(candidate, roots[0]);
		}
	}
}

/**
 * Convenience wrapper used by tools: resolves, checks, and returns the
 * validated absolute path. The error message never leaks other roots.
 */
export function enforceSandbox(
	resolvedUriFsPath: string,
	opts: {
		existsOnDisk: boolean;
		readRealPath: () => string | undefined;
		getConfig: () => SandboxConfig;
		getFolders: () => Array<{ fsPath: string }>;
		toolName: string;
	}
): string {
	const cfg = opts.getConfig();
	if (cfg.mode === 'full') return resolvedUriFsPath;

	const real = opts.existsOnDisk ? opts.readRealPath() : undefined;
	try {
		assertInSandbox(resolvedUriFsPath, real, cfg, opts.getFolders(), opts.toolName);
	} catch (e) {
		if (e instanceof SandboxViolationError) {
			throw new SandboxViolationError(resolvedUriFsPath, e.root);
		}
		throw e;
	}
	return resolvedUriFsPath;
}
