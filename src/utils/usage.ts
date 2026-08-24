// Local-only usage counters. Nothing here leaves the machine — the numbers
// back the get_server_info_code report so users can see which tools their
// coding agents actually lean on.
const startedAt = Date.now();
const callCounts = new Map<string, number>();

export function recordToolCall(toolName: string): void {
	callCounts.set(toolName, (callCounts.get(toolName) ?? 0) + 1);
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
