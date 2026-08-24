/**
 * Cluster coordinator: the state machine every VS Code window runs.
 *
 * standalone -> hub     the moment a second window registers (no separate boot
 *                       path; hosting is something that happens to you)
 * standalone -> spoke   the configured port was taken by a verified sibling
 * spoke -> hub          the hub died and this window won the re-bind race
 *
 * The client URL never changes: whatever the role, exactly one window owns the
 * configured port and serves /mcp; everyone else forwards to it.
 */
import { logger } from '../utils/logger';
import { displayLabelFor, listWorkspaceFolders } from '../utils/workspace';
import { setClusterDisplay } from '../utils/workspace';
import { ClusterHub, slugFolderName } from './hub';
import { resolveRoute } from './routing';
import {
	BROADCAST_TIMEOUT_MS,
	CLUSTER_DEREGISTER_PATH,
	CLUSTER_HEARTBEAT_PATH,
	CLUSTER_HUB_SHUTDOWN_PATH,
	CLUSTER_IDENTITY_PATH,
	CLUSTER_PROTOCOL_VERSION,
	CLUSTER_REGISTER_PATH,
	DEREGISTER_TIMEOUT_MS,
	FolderInfo,
	HEARTBEAT_INTERVAL_MS,
	IDENTITY_TIMEOUT_MS,
	INVOKE_TIMEOUT_MS,
	INVOKE_PATH,
	RegisterRequest,
	RouteDecision,
	WindowInfo
} from './types';

/**
 * Environment-independent UUID shape. The extension host's Node does not
 * guarantee a global webcrypto, so window ids cannot rely on crypto.randomUUID.
 */
function randomId(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** What the coordinator needs from the HTTP server it lives inside. */
export interface ClusterHost {
	/** Binds the shared express app; rejects with the underlying error (code EADDRINUSE et al). */
	listenOn(port: number, host: string): Promise<number>;
	/** Closes whichever listener currently holds the app. */
	closeListener(): Promise<void>;
	/** Executes a registered tool handler directly (post-zod), bypassing routing. */
	invokeLocally(tool: string, args: Record<string, unknown>): Promise<unknown>;
	/** True when this window registered the tool (enabledTools differ per window). */
	hasTool(tool: string): boolean;
}

export interface ClusterStatus {
	role: 'standalone' | 'hub' | 'spoke';
	port: number;
	label: string;
	windows: number;
}

interface BroadcastParticipant {
	windowId: string;
	windowLabel: string;
	port: number; // 0 => execute here
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function textOfResult(result: unknown): { text: string; isError: boolean } {
	const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
	if (Array.isArray(r?.content)) {
		const text = r.content
			.filter(c => c.type === 'text' && typeof c.text === 'string')
			.map(c => c.text)
			.join('\n');
		if (text) {
			return { text, isError: Boolean(r.isError) };
		}
	}
	return { text: JSON.stringify(result), isError: Boolean(r?.isError) };
}

export class ClusterCoordinator {
	readonly windowId = randomId();
	private state: 'standalone' | 'hub' | 'spoke' = 'standalone';
	private hub?: ClusterHub;
	private hubPort?: number;      // while a spoke: where the hub listens
	private spokePort?: number;    // while a spoke: our own invoke listener
	private selfLabel: string;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private heartbeatFailures = 0;
	private stopping = false;
	private onStateChange?: (status: ClusterStatus) => void;

	constructor(
		private host: ClusterHost,
		private preferredPort: number,
		private preferredHost: string,
		getExtensionVersion: () => string
	) {
		this.selfLabel = this.proposeSelfName();
		this.extensionVersion = getExtensionVersion();
		this.hub = new ClusterHub(() => this.selfFolders(), this.selfLabel);
	}

	private extensionVersion: string;
	/**
	 * Credential presented on every cluster call. Both windows on one machine
	 * read the same globalState, so a spoke naturally holds the hub's session
	 * secret; remote callers over a tunnel have no such copy.
	 */
	setClusterCredential(getToken: () => string | undefined): void {
		this.getCredential = getToken;
	}
	private getCredential: () => string | undefined = () => undefined;

	private authHeaders(): Record<string, string> {
		const t = this.getCredential();
		return t ? { 'X-MCP-Cluster': t } : {};
	}

	setOnStateChange(cb: (status: ClusterStatus) => void): void {
		this.onStateChange = cb;
	}

	getRole(): ClusterStatus['role'] {
		return this.state;
	}

	private proposeSelfName(): string {
		const folders = listWorkspaceFolders();
		return slugFolderName(folders[0]?.name ?? 'window');
	}

	private selfFolders(): FolderInfo[] {
		return listWorkspaceFolders().map(f => ({
			name: f.name,
			label: displayLabelFor(f),
			fsPath: f.uri.fsPath
		}));
	}

	private emitState(): void {
		this.onStateChange?.(this.statusSnapshot());
	}

	statusSnapshot(): ClusterStatus {
		return {
			role: this.state,
			port: this.preferredPort,
			label: this.selfLabel,
			windows: 1 + (this.hub?.spokeCount ?? 0)
		};
	}

	// --- Routing -------------------------------------------------------------

	private currentView() {
		if (this.state === 'spoke') {
			// A spoke never routes: whatever reaches its handlers is already home
			return { folders: [] };
		}
		return { folders: this.hub!.view(this.selfFolders(), this.windowId) };
	}

	resolveRoute(tool: string, args: Record<string, unknown>): RouteDecision {
		return resolveRoute(tool, args, this.currentView());
	}

	/**
	 * Runs a routed decision: locally, forwarded to one window, or fanned out
	 * to all of them. `handler` is the untouched tool callback so broadcast can
	 * include this window's own answer without re-entering the router.
	 */
	async dispatchRoute(
		tool: string,
		decision: RouteDecision,
		cbArgs: unknown[],
		handler: (...cbArgs: unknown[]) => unknown
	): Promise<unknown> {
		if (decision.kind === 'local') {
			if (decision.args) {
				cbArgs[0] = decision.args;
			}
			return handler(...cbArgs);
		}
		if (decision.kind === 'remote') {
			return this.forwardTo(decision.port, tool, decision.args, decision.windowLabel, decision.windowId, INVOKE_TIMEOUT_MS);
		}
		return this.broadcast(tool, cbArgs, handler);
	}

	private async forwardTo(
		port: number,
		tool: string,
		args: Record<string, unknown>,
		windowLabel: string,
		windowId: string,
		timeoutMs: number
	): Promise<unknown> {
		let response: Response;
		try {
			response = await fetchWithTimeout(`http://127.0.0.1:${port}${INVOKE_PATH}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
				body: JSON.stringify({ tool, args })
			}, timeoutMs);
		} catch (error) {
			const aborted = error instanceof Error && error.name === 'AbortError';
			if (aborted) {
				throw new Error(`Window "${windowLabel}" did not finish within ${Math.round(timeoutMs / 1000)}s.`);
			}
			// A refused loopback connect means the process is gone; no grace period
			this.hub?.deregister(windowId);
			throw new Error(`Window "${windowLabel}" closed before the call completed — retry; its folders are no longer served.`);
		}
		const body = await response.json().catch(() => undefined) as { ok?: boolean; result?: unknown; message?: string } | undefined;
		if (response.ok && body?.ok) {
			return body.result;
		}
		throw new Error(`[window ${windowLabel}] ${body?.message ?? `invoke failed with HTTP ${response.status}`}`);
	}

	private async broadcast(tool: string, cbArgs: unknown[], handler: (...cbArgs: unknown[]) => unknown): Promise<unknown> {
		const participants: BroadcastParticipant[] = [
			{ windowId: this.windowId, windowLabel: `${this.selfLabel} (this window)`, port: 0 },
			...(this.hub?.getSpokes() ?? []).map(s => ({ windowId: s.windowId, windowLabel: s.label, port: s.port }))
		];
		const settled = await Promise.allSettled(participants.map(async p => {
			const result = p.port === 0
				? await handler(...cbArgs)
				: await this.forwardTo(p.port, tool, cbArgs[0] as Record<string, unknown>, p.windowLabel, p.windowId, BROADCAST_TIMEOUT_MS);
			return { participant: p, outcome: textOfResult(result) };
		}));

		const sections = settled.map((outcome, i) => {
			if (outcome.status === 'fulfilled') {
				return `[window ${participants[i].windowLabel}]\n${outcome.value.outcome.text}`;
			}
			const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			return `[window ${participants[i].windowLabel}] unavailable: ${reason}`;
		});
		const answered = settled.filter(s => s.status === 'fulfilled') as PromiseFulfilledResult<{ participant: BroadcastParticipant; outcome: { text: string; isError: boolean } }>[];
		const allFailed = answered.length === 0 || answered.every(s => s.value.outcome.isError);
		return { content: [{ type: 'text', text: sections.join('\n\n') }], isError: allFailed };
	}

	// --- Hub-side endpoints ----------------------------------------------------

	handleIdentity(): Record<string, unknown> {
		return {
			role: 'hub',
			protocol: CLUSTER_PROTOCOL_VERSION,
			extensionVersion: this.extensionVersion,
			port: this.preferredPort
		};
	}

	handleRegister(req: RegisterRequest): { status: number; body: Record<string, unknown> } {
		if (req.protocol !== CLUSTER_PROTOCOL_VERSION || req.extensionVersion !== this.extensionVersion) {
			logger.info(`[cluster] Refused registration from version ${req.extensionVersion} (this window: ${this.extensionVersion})`);
			return {
				status: 409,
				body: {
					ok: false,
					code: 'VERSION_MISMATCH',
					detail: `this window runs ${this.extensionVersion}; reload both windows onto the same version`
				}
			};
		}
		// Defense in depth (F1): a registration is only ever a loopback
		// handshake between VS Code windows. Reject shapes no real join
		// produces instead of trusting the caller.
		if (!Number.isInteger(req.port) || req.port < 1024 || req.port > 65535) {
			return { status: 400, body: { ok: false, code: 'INVALID_PORT' } };
		}
		if (typeof req.windowId !== 'string' || !req.windowId || req.windowId.length > 128
			|| typeof req.proposedName !== 'string' || req.proposedName.length > 256
			|| !Array.isArray((req as unknown as { folders?: unknown }).folders)) {
			return { status: 400, body: { ok: false, code: 'INVALID_REQUEST' } };
		}
		for (const f of (req as unknown as { folders: Array<{ name?: unknown; fsPath?: unknown }> }).folders) {
			if (typeof f !== 'object' || f === null
				|| typeof f.name !== 'string' || typeof f.fsPath !== 'string'
				|| f.name.length > 512 || f.fsPath.length > 1024) {
				return { status: 400, body: { ok: false, code: 'INVALID_FOLDERS' } };
			}
		}
		const wasStandalone = this.state === 'standalone';
		const result = this.hub!.register(req);
		if (wasStandalone) {
			this.becomeHub();
		}
		logger.info(`[cluster] Window "${result.assignedName}" registered (${result.windows} window(s) in the cluster)`);
		this.emitState();
		return { status: 200, body: result as unknown as Record<string, unknown> };
	}

	handleHeartbeat(windowId: string, port: number, folders: Array<{ name: string; fsPath: string }>): { status: number; body: Record<string, unknown> } {
		if (this.state === 'spoke') {
			return { status: 503, body: { ok: false, code: 'NOT_ACCEPTING' } };
		}
		const result = this.hub!.heartbeat(windowId, port, folders);
		return { status: result.ok ? 200 : 404, body: result as unknown as Record<string, unknown> };
	}

	handleDeregister(windowId: string): void {
		if (this.state !== 'spoke') {
			this.hub?.deregister(windowId);
			logger.info(`[cluster] Window ${windowId} deregistered`);
			this.emitState();
		}
	}

	// --- Spoke-side endpoints ---------------------------------------------------

	async handleInvoke(body: { tool?: unknown; args?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
		const tool = typeof body.tool === 'string' ? body.tool : undefined;
		const args = (body.args && typeof body.args === 'object' ? body.args : undefined) as Record<string, unknown> | undefined;
		if (!tool || !args) {
			return { status: 400, body: { ok: false, code: 'HANDLER_ERROR', message: 'malformed invoke payload' } };
		}
		// A window only registers the tool groups its enabledTools allows, so a
		// miss here is a routing fact (404), not a crash (500)
		if (!this.host.hasTool(tool)) {
			return { status: 404, body: { ok: false, code: 'TOOL_NOT_FOUND', message: `Tool ${tool} is not enabled on this window` } };
		}
		try {
			const result = await this.host.invokeLocally(tool, args);
			return { status: 200, body: { ok: true, result } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: 500, body: { ok: false, code: 'HANDLER_ERROR', message } };
		}
	}

	/** A dying hub told us to take over immediately instead of waiting out the lease. */
	handleHubShutdown(): void {
		if (this.state !== 'spoke') {
			return;
		}
		logger.info('[cluster] Hub announced shutdown — starting election');
		// Fire-and-forget: a failed election (port lost to a foreign process,
		// rejoin refused) must surface in the log, never as an unhandled
		// rejection crashing the extension host
		void this.runElection().catch(error => {
			logger.error(`[cluster] Election after hub shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	// --- Lifecycle ----------------------------------------------------------------

	/**
	 * Called when binding the configured port failed. Verifies who owns the
	 * port and either joins as a spoke or rethrows a precise error.
	 */
	async joinAfterAddressInUse(originalError: Error): Promise<void> {
		let identity: { role?: string; protocol?: number; extensionVersion?: string } | undefined;
		try {
			const response = await fetchWithTimeout(`http://127.0.0.1:${this.preferredPort}${CLUSTER_IDENTITY_PATH}`, {}, IDENTITY_TIMEOUT_MS);
			identity = await response.json().catch(() => undefined);
		} catch {
			identity = undefined;
		}

		if (!identity || identity.role !== 'hub' || typeof identity.protocol !== 'number') {
			// Not ours: keep today's error story verbatim
			throw originalError;
		}
		if (identity.protocol !== CLUSTER_PROTOCOL_VERSION || identity.extensionVersion !== this.extensionVersion) {
			throw new Error(
				`Port ${this.preferredPort} is held by another VS Code window running MCP Server ` +
				`${identity.extensionVersion ?? 'of a different version'} — reload or update both windows onto the same version to share the server.`
			);
		}
		await this.becomeSpoke(this.preferredPort);
	}

	/** Binds an ephemeral loopback listener and registers with the hub, with retries. */
	private async becomeSpoke(hubPort: number): Promise<void> {
		this.stopping = false;
		this.state = 'spoke';
		if (this.spokePort === undefined) {
			this.spokePort = await this.host.listenOn(0, '127.0.0.1');
		}
		this.hubPort = hubPort;

		let lastError: unknown;
		for (let attempt = 0; attempt < 6; attempt++) {
			try {
				await this.registerOnce();
				this.startHeartbeat();
				this.emitState();
				logger.info(`[cluster] Joined as spoke "${this.selfLabel}" — hub at 127.0.0.1:${hubPort}, invoke on 127.0.0.1:${this.spokePort}`);
				return;
			} catch (error) {
				lastError = error;
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}
		// The hub died mid-join: fall into election rather than giving up
		logger.warn(`[cluster] Registration failed repeatedly (${lastError instanceof Error ? lastError.message : lastError}); running election`);
		await this.runElection();
	}

	private async registerOnce(): Promise<void> {
		const folders = this.selfFolders();
		const req: RegisterRequest = {
			role: 'spoke',
			protocol: CLUSTER_PROTOCOL_VERSION,
			extensionVersion: this.extensionVersion,
			windowId: this.windowId,
			proposedName: this.proposeSelfName(),
			port: this.spokePort!,
			folders: folders.map(f => ({ name: f.name, fsPath: f.fsPath }))
		};
		const response = await fetchWithTimeout(`http://127.0.0.1:${this.hubPort}${CLUSTER_REGISTER_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
			body: JSON.stringify(req)
		}, IDENTITY_TIMEOUT_MS);
		const body = await response.json().catch(() => undefined) as { ok?: boolean; assignedName?: string; labelOverrides?: Record<string, string> } | undefined;
		if (!response.ok || !body?.ok) {
			throw new Error(`registration refused (HTTP ${response.status})`);
		}
		this.selfLabel = body.assignedName ?? this.selfLabel;
		// Displays must carry the cluster-assigned labels so paths stay attributable
		setClusterDisplay(true, body.labelOverrides ?? {});
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatFailures = 0;
		this.heartbeatTimer = setInterval(() => void this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private async heartbeatTick(): Promise<void> {
		if (this.state !== 'spoke' || this.hubPort === undefined) {
			return;
		}
		try {
			const response = await fetchWithTimeout(`http://127.0.0.1:${this.hubPort}${CLUSTER_HEARTBEAT_PATH}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
				body: JSON.stringify({
					windowId: this.windowId,
					port: this.spokePort,
					folders: this.selfFolders().map(f => ({ name: f.name, fsPath: f.fsPath }))
				})
			}, HEARTBEAT_INTERVAL_MS);
			this.heartbeatFailures = 0;
			if (response.status === 404) {
				// Hub restarted and lost us: claim a place again
				await this.registerOnce();
			}
		} catch {
			this.heartbeatFailures++;
			if (this.heartbeatFailures >= 2) {
				logger.info('[cluster] Hub stopped answering heartbeats — starting election');
				this.stopHeartbeat();
				await this.runElection();
			}
		}
	}

	/** Folder set changed mid-session: push it promptly instead of waiting a beat. */
	async folderSetChanged(): Promise<void> {
		if (this.state === 'spoke') {
			try {
				await this.registerOnce();
			} catch (error) {
				logger.warn(`[cluster] Re-register after folder change failed: ${error instanceof Error ? error.message : error}`);
			}
		}
		this.emitState();
	}

	private becomeHub(): void {
		this.state = 'hub';
		// Keep prefixes on: this window now speaks for more than itself
		setClusterDisplay(true, {});
		this.hub!.startSweep(evicted => {
			for (const rec of evicted) {
				logger.info(`[cluster] Window "${rec.label}" dropped after going silent`);
			}
			this.emitState();
		});
	}

	/**
	 * The hub is gone. Every orphan jitters, then races for the configured
	 * port; losers find the winner there and rejoin as spokes.
	 */
	private async runElection(): Promise<void> {
		if (this.stopping || this.state === 'hub') {
			return;
		}
		// Deterministic per-window jitter spreads the contenders without any coordination
		let hash = 0;
		for (const ch of this.windowId) {
			hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
		}
		const jitter = hash % 1000;
		await new Promise(resolve => setTimeout(resolve, jitter));

		if (this.stopping) {
			return;
		}
		this.stopHeartbeat();
		try {
			await this.host.closeListener();
		} catch {
			// Nothing bound; nothing to tear down
		}
		try {
			await this.host.listenOn(this.preferredPort, this.preferredHost);
			this.spokePort = undefined;
			this.hubPort = undefined;
			this.state = 'standalone';
			this.selfLabel = this.proposeSelfName();
			this.becomeHub();
			this.emitState();
			logger.info(`[cluster] Election won — this window now hosts the cluster on port ${this.preferredPort}`);
		} catch (bindError) {
			// Someone else won. Verify it is really our extension, then rejoin.
			try {
				const response = await fetchWithTimeout(`http://127.0.0.1:${this.preferredPort}${CLUSTER_IDENTITY_PATH}`, {}, IDENTITY_TIMEOUT_MS);
				const identity = await response.json().catch(() => undefined) as { role?: string; protocol?: number; extensionVersion?: string } | undefined;
				if (identity?.role === 'hub' && identity.protocol === CLUSTER_PROTOCOL_VERSION && identity.extensionVersion === this.extensionVersion) {
					this.spokePort = undefined;
					await this.becomeSpoke(this.preferredPort);
					return;
				}
			} catch {
				// fall through to the failure report
			}
			const detail = bindError instanceof Error ? bindError.message : String(bindError);
			logger.error(`[cluster] Election lost and rejoin failed: ${detail}`);
			this.state = 'standalone';
			setClusterDisplay(false);
			this.emitState();
			throw new Error(`MCP Server could not reclaim or rejoin the cluster: ${detail}`);
		}
	}

	/** Clean shutdown: goodbye posts first, listeners and timers after. */
	async stop(): Promise<void> {
		this.stopping = true;
		this.stopHeartbeat();
		if (this.state === 'spoke' && this.hubPort !== undefined) {
			try {
				await fetchWithTimeout(`http://127.0.0.1:${this.hubPort}${CLUSTER_DEREGISTER_PATH}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
					body: JSON.stringify({ windowId: this.windowId })
				}, DEREGISTER_TIMEOUT_MS);
			} catch {
				// Lease expiry is the safety net
			}
		}
		if (this.state === 'hub' && this.hub && this.hub.spokeCount > 0) {
			// Best-effort heads-up so spokes promote immediately; missed pings
			// cost them one lease period at most
			await Promise.allSettled(this.hub.getSpokes().map(spoke =>
				fetchWithTimeout(`http://127.0.0.1:${spoke.port}${CLUSTER_HUB_SHUTDOWN_PATH}`, {
					method: 'POST',
					headers: { ...this.authHeaders() }
				}, DEREGISTER_TIMEOUT_MS)
			));
		}
		this.hub?.stopSweep();
		this.state = 'standalone';
		setClusterDisplay(false);
		this.emitState();
	}

	// --- Introspection for tools and the status bar ------------------------------

	getSpokes(): WindowInfo[] {
		return this.hub?.getSpokes() ?? [];
	}

	isDistributed(): boolean {
		return this.state === 'spoke' || (this.state === 'hub' && (this.hub?.spokeCount ?? 0) > 0);
	}

	/** One line appended to get_server_info_code output; undefined keeps it byte-identical. */
	clusterInfoLine(): string | undefined {
		if (this.state === 'spoke') {
			return `- Cluster: joined as "${this.selfLabel}" — calls are served through http://127.0.0.1:${this.hubPort}/mcp`;
		}
		if (this.state === 'hub' && this.hub && this.hub.spokeCount > 0) {
			const spokes = this.hub.getSpokes()
				.map(s => `${s.label} (${s.folders.map(f => f.label).join(', ')})`)
				.join(', ');
			return `- Cluster: hub at http://127.0.0.1:${this.preferredPort}/mcp — ${this.hub.spokeCount} joined window(s): ${spokes}`;
		}
		return undefined;
	}

	/** Global folder numbering across windows for list_workspace_folders_code; undefined when alone. */
	clusterFolderListing(): { lines: string[]; windowsFooter: string } | undefined {
		if (!this.isDistributed() || this.state === 'spoke') {
			return undefined;
		}
		const view = this.currentView().folders;
		if (view.length === 0) {
			return undefined;
		}
		const lines = view.map((f, i) => `${i + 1}. ${f.label} -> ${f.fsPath}`);
		const windowNames = [...new Set(view.map(f =>
			f.port === 0 ? `${f.windowLabel} (this window)` : f.windowLabel
		))];
		return { lines, windowsFooter: windowNames.join(', ') };
	}
}
