import * as path from 'path';

export type SandboxMode = 'workspace' | 'home' | 'full';

export interface SandboxConfig {
	mode: SandboxMode;
	
	allowPaths: string[];
	
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

function normalizeForCompare(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isSubpath(root: string, target: string): boolean {
	const r = normalizeForCompare(root);
	const t = normalizeForCompare(target);
	if (!r) return true;
	return t === r || t.startsWith(r + '/');
}

export function computeAllowedRoots(
	config: SandboxConfig,
	workspaceFolders: Array<{ fsPath: string }>
): string[] {
	const roots: string[] = [];
	switch (config.mode) {
		case 'full':
			return []; 
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
	
	const seen = new Set<string>();
	return roots.filter(r => {
		if (!r) return false;
		const k = normalizeForCompare(r);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

export function assertInSandbox(
	targetPath: string,
	realTarget: string | undefined,
	config: SandboxConfig,
	workspaceFolders: Array<{ fsPath: string }>,
	toolName: string
): void {
	const roots = computeAllowedRoots(config, workspaceFolders);
	if (roots.length === 0) return; 

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
