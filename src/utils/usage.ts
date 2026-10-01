const startedAt = Date.now();
const callCounts = new Map<string, number>();
let registered: string[] = [];

export interface UsagePersistence {
	load(): Record<string, number> | undefined;
	save(counts: Record<string, number>): void;
}

let persistence: UsagePersistence | undefined;

export function setUsagePersistence(store: UsagePersistence | undefined): void {
	persistence = store;
	const stored = store?.load();
	if (stored) {
		for (const [tool, calls] of Object.entries(stored)) {
			if (typeof calls === 'number' && Number.isFinite(calls) && calls > 0) {
				callCounts.set(tool, Math.max(callCounts.get(tool) ?? 0, Math.floor(calls)));
			}
		}
	}
}

export function saveUsage(): void {
	if (!persistence) {
		return;
	}
	const counts: Record<string, number> = {};
	for (const [tool, calls] of callCounts.entries()) {
		counts[tool] = calls;
	}
	persistence.save(counts);
}

export function setRegisteredTools(names: string[]): void {
	registered = [...names];
}

export function recordToolCall(toolName: string): void {
	callCounts.set(toolName, (callCounts.get(toolName) ?? 0) + 1);
}

function neverCalledAll(): string[] {
	return registered.filter(name => !callCounts.has(name)).sort();
}

export function getNeverCalledTools(limit: number): string[] {
	return neverCalledAll().slice(0, limit);
}

export function getNeverCalledCount(): number {
	return neverCalledAll().length;
}

export function getUsageSnapshot(): Array<{ tool: string; calls: number }> {
	return [...callCounts.entries()]
		.map(([tool, calls]) => ({ tool, calls }))
		.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

export function getTotalCalls(): number {
	let total = 0;
	for (const calls of callCounts.values()) {
		total += calls;
	}
	return total;
}

export function getServerStartTime(): number {
	return startedAt;
}
