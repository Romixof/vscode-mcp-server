/**
 * Wire contract for the multi-window cluster: one VS Code window hosts the MCP
 * server (the hub) and the others join it as spokes over loopback, so a client
 * keeps a single URL no matter how many windows are open. Every cross-window
 * message is JSON under these shapes.
 */

/** Bump whenever a wire shape changes; windows on different versions refuse to join. */
export const CLUSTER_PROTOCOL_VERSION = 1;

export const HEARTBEAT_INTERVAL_MS = 5000;
/** Three missed beats evict a silent spoke; generous so a busy tool call never evicts a live window. */
export const LEASE_MS = 15000;
export const SWEEP_INTERVAL_MS = 7500;
export const IDENTITY_TIMEOUT_MS = 2000;
/** Tool calls can legitimately run for minutes (long shells); only truly hung handlers hit this. */
export const INVOKE_TIMEOUT_MS = 600000;
export const BROADCAST_TIMEOUT_MS = 30000;
export const REGISTER_ATTEMPTS = 6;
export const REGISTER_RETRY_MS = 500;
/** Cap on the polite goodbye posted when a spoke toggles off; lease expiry is the real safety net. */
export const DEREGISTER_TIMEOUT_MS = 1500;

export const CLUSTER_IDENTITY_PATH = '/__mcp_cluster/identity';
export const CLUSTER_REGISTER_PATH = '/__mcp_cluster/register';
export const CLUSTER_HEARTBEAT_PATH = '/__mcp_cluster/heartbeat';
export const CLUSTER_DEREGISTER_PATH = '/__mcp_cluster/deregister';
/** Hub -> spokes on shutdown so they promote immediately instead of waiting out the lease. */
export const CLUSTER_HUB_SHUTDOWN_PATH = '/__mcp_cluster/hub-shutdown';
/** Hub -> spoke tool execution. Lives outside the /__mcp_cluster namespace because it is the data plane, not control traffic. */
export const INVOKE_PATH = '/invoke';

/** One workspace root as the cluster sees it. */
export interface FolderInfo {
	/** Folder name as VS Code reports it to the window that has it open. */
	name: string;
	/**
	 * Cluster-globally unique display label. Equals `name` unless another
	 * window already claimed that name; overrides keep displayed paths
	 * attributable and round-trippable.
	 */
	label: string;
	fsPath: string;
}

/** A registered spoke window. */
export interface WindowInfo {
	windowId: string;
	label: string;
	port: number;
	folders: FolderInfo[];
}

/** Registration body sent by a joining window. */
export interface RegisterRequest {
	role: 'spoke';
	protocol: number;
	extensionVersion: string;
	windowId: string;
	proposedName: string;
	port: number;
	folders: Array<{ name: string; fsPath: string }>;
}

/** Registration reply; labelOverrides carries only entries that differ from the local name. */
export interface RegisterResponse {
	ok: boolean;
	code?: 'VERSION_MISMATCH';
	detail?: string;
	assignedName?: string;
	leaseMs?: number;
	labelOverrides?: Record<string, string>;
	windows?: number;
}

/** What the cluster looks like to the router at the moment of a call, in canonical folder order. */
export interface RoutedFolder extends FolderInfo {
	windowId: string;
	/** Invoke port of the owning window; 0 means this window itself. */
	port: number;
	windowLabel: string;
}

export interface ClusterView {
	folders: RoutedFolder[];
}

export type RouteDecision =
	| { kind: 'local'; /** Pre-resolved args when routing had to rewrite cluster-global vocabulary. */ args?: Record<string, unknown> }
	| { kind: 'remote'; windowId: string; windowLabel: string; port: number; args: Record<string, unknown> }
	| { kind: 'broadcast' };

/** Hub -> spoke execution request. */
export interface InvokeRequest {
	tool: string;
	args: Record<string, unknown>;
}

export type InvokeResponse =
	| { ok: true; result: unknown }
	| { ok: false; code: 'TOOL_NOT_FOUND' | 'HANDLER_ERROR'; message: string };
