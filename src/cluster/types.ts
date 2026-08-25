export const CLUSTER_PROTOCOL_VERSION = 1;

export const HEARTBEAT_INTERVAL_MS = 5000;

export const LEASE_MS = 15000;
export const SWEEP_INTERVAL_MS = 7500;
export const IDENTITY_TIMEOUT_MS = 2000;

export const INVOKE_TIMEOUT_MS = 600000;
export const BROADCAST_TIMEOUT_MS = 30000;
export const REGISTER_ATTEMPTS = 6;
export const REGISTER_RETRY_MS = 500;

export const DEREGISTER_TIMEOUT_MS = 1500;

export const CLUSTER_IDENTITY_PATH = '/__mcp_cluster/identity';
export const CLUSTER_REGISTER_PATH = '/__mcp_cluster/register';
export const CLUSTER_HEARTBEAT_PATH = '/__mcp_cluster/heartbeat';
export const CLUSTER_DEREGISTER_PATH = '/__mcp_cluster/deregister';

export const CLUSTER_HUB_SHUTDOWN_PATH = '/__mcp_cluster/hub-shutdown';

export const INVOKE_PATH = '/invoke';

export interface FolderInfo {

	name: string;

	label: string;
	fsPath: string;
}

export interface WindowInfo {
	windowId: string;
	label: string;
	port: number;
	folders: FolderInfo[];
}

export interface RegisterRequest {
	role: 'spoke';
	protocol: number;
	extensionVersion: string;
	windowId: string;
	proposedName: string;
	port: number;
	folders: Array<{ name: string; fsPath: string }>;
}

export interface RegisterResponse {
	ok: boolean;
	code?: 'VERSION_MISMATCH';
	detail?: string;
	assignedName?: string;
	leaseMs?: number;
	labelOverrides?: Record<string, string>;
	windows?: number;
}

export interface RoutedFolder extends FolderInfo {
	windowId: string;

	port: number;
	windowLabel: string;
}

export interface ClusterView {
	folders: RoutedFolder[];
}

export type RouteDecision =
	| { kind: 'local';  args?: Record<string, unknown> }
	| { kind: 'remote'; windowId: string; windowLabel: string; port: number; args: Record<string, unknown> }
	| { kind: 'broadcast' };

export interface InvokeRequest {
	tool: string;
	args: Record<string, unknown>;
}

export type InvokeResponse =
	| { ok: true; result: unknown }
	| { ok: false; code: 'TOOL_NOT_FOUND' | 'HANDLER_ERROR'; message: string };
