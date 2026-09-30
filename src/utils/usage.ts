const startedAt = Date.now();
const callCounts = new Map<string, number>();
let registered: string[] = [];

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
