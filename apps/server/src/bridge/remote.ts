/**
 * RemoteAgentBridge — AgentBridge implementation over the agent-host wire
 * protocol (see packages/protocol HostClientFrame/HostServerFrame).
 *
 * One HostClient per registered machine holds a WebSocket connection (auth
 * handshake first frame, exponential-backoff reconnect) plus an HTTP fetch
 * wrapper for request/response ops. Sessions created on a machine are tracked
 * locally in a Map keyed by the host's SDK session id; every frame type the
 * deck's ws.ts consumes (session_event, ext_ui_*, plan_*) is routed from the
 * host's connection through the matching RemoteSessionHandle listener sets,
 * so the deck's WsHub needs zero changes.
 *
 * Snapshot hydration: the host replies to `subscribe` with an authoritative
 * `subscribed` snapshot. The deck caches it and re-emits it to subscribed
 * clients as a synthetic `host_snapshot` session event (the web reducer
 * hydrates messages from it), because the ws.ts `subscribed` frame uses the
 * local (initially empty) cache.
 */
import type { HostClientFrame, HostServerFrame, ImageAttachment, ModelInfo, ModelRef, SessionSnapshot, SessionSummary } from "@omp-deck/protocol";

import { executeDeckSlashCommand } from "../deck-slash-commands.ts";
import { logger } from "../log.ts";
import i18n from "../i18n.ts";
import type { MachineEntry, MachineRegistry } from "../machines.ts";
import { bridgeT } from "../../../agent-host/src/bridge/bridge-context.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	EventListener,
	PlanApprovalResponse,
	RuntimeEnvUpdate,
	SessionHandle,
	SlashDispatchResult,
} from "./types.ts";

const log = logger("bridge:remote");

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

type UiFrame = Extract<HostServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>;
type PlanFrame = Extract<HostServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>;
type UiFrameListener = (frame: UiFrame) => void;
type PlanFrameListener = (frame: PlanFrame) => void;

// ─────────────────────────────────────────────────────────────────────────────
// HostClient — one machine connection
// ─────────────────────────────────────────────────────────────────────────────

interface HostFrameListener {
	(sessionId: string, frame: HostServerFrame): void;
}

export class HostClient {
	readonly machine: MachineEntry;
	online = false;
	private ws: WebSocket | null = null;
	private reconnectDelayMs = RECONNECT_BASE_MS;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private subscribedSessions = new Set<string>();
	private readonly frameListener: HostFrameListener;

	constructor(machine: MachineEntry, frameListener: HostFrameListener) {
		this.machine = machine;
		this.frameListener = frameListener;
	}

	start(): void {
		this.connect();
	}

	/** Reconnect immediately (used after a successful REST round-trip when offline). */
	ensureOnline(): void {
		if (this.online || this.disposed) return;
		this.connect();
	}

	subscribeSession(sessionId: string): void {
		this.subscribedSessions.add(sessionId);
		this.send({ type: "subscribe", sessionId });
	}

	unsubscribeSession(sessionId: string): void {
		this.subscribedSessions.delete(sessionId);
		this.send({ type: "unsubscribe", sessionId });
	}

	/** @returns false when the frame was dropped (socket not open). */
	send(frame: HostClientFrame): boolean {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		try {
			ws.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			log.warn(`host send failed for ${this.machine.id}`, err);
			return false;
		}
	}

	async rest<T>(path: string, init?: RequestInit): Promise<T> {
		const url = `${this.machine.baseUrl.replace(/\/+$/, "")}${path}`;
		const res = await fetch(url, {
			...init,
			headers: {
				...(init?.headers ?? {}),
				Authorization: `Bearer ${this.machine.token}`,
				...(init?.body ? { "Content-Type": "application/json" } : {}),
			},
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`host ${this.machine.id} ${path} failed: ${res.status} ${body.slice(0, 200)}`);
		}
		return (await res.json()) as T;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			try {
				ws.close();
			} catch {
				// already closed
			}
		}
	}

	// ─── internals ────────────────────────────────────────────────────────

	private connect(): void {
		if (this.disposed) return;
		// Re-entry guard: a CONNECTING/OPEN socket must not be duplicated by
		// ensureOnline() racing the reconnect timer or a manual kick.
		const current = this.ws;
		if (current && current.readyState !== WebSocket.CLOSED) return;
		const base = this.machine.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
		const ws = new WebSocket(`${base}/host/ws`);
		this.ws = ws;
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: "auth", token: this.machine.token } satisfies HostClientFrame));
		};
		ws.onmessage = (ev) => {
			let frame: HostServerFrame;
			try {
				frame = JSON.parse(String(ev.data)) as HostServerFrame;
			} catch {
				log.warn(`host ${this.machine.id} sent invalid frame`);
				return;
			}
			this.handleFrame(frame);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return; // stale connection (superseded)
			this.ws = null;
			this.online = false;
			if (this.disposed) return;
			this.scheduleReconnect();
		};
		ws.onerror = () => {
			// onclose follows; nothing to do here.
		};
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = this.reconnectDelayMs;
		this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private handleFrame(frame: HostServerFrame): void {
		switch (frame.type) {
			case "host_ready":
				this.online = true;
				this.reconnectDelayMs = RECONNECT_BASE_MS;
				log.info(`host ${this.machine.id} connected (machineId=${frame.machineId})`);
				// Re-subscribe everything the deck still cares about.
				for (const sessionId of this.subscribedSessions) {
					this.send({ type: "subscribe", sessionId });
				}
				return;
			case "host_error":
				log.warn(`host ${this.machine.id} error: ${frame.message}`);
				return;
			case "hello":
			case "pong":
			case "heartbeat":
			case "tasks_changed":
			case "skills_changed":
			case "kb_changed":
			case "notification":
			case "oauth_progress":
			case "oauth_complete":
			case "oauth_failed":
			case "oauth_consent":
			case "oauth_prompt":
			case "models_changed":
			case "routine_run_started":
			case "routine_step_event":
			case "routine_run_finished":
				// Broadcast-ish frames the host never emits; ignore defensively.
				return;
			case "session_event":
			case "subscribed":
			case "unsubscribed":
			case "session_disposed":
			case "ext_ui_dialog_open":
			case "ext_ui_dialog_cancel":
			case "plan_mode_changed":
			case "plan_proposed":
			case "plan_proposal_resolved":
			case "error":
				this.frameListener(frame.sessionId ?? "", frame);
				return;
			default:
				// Unknown future frame — ignore rather than crash the link.
				return;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// RemoteSessionHandle — local mirror of a host session
// ─────────────────────────────────────────────────────────────────────────────

interface RemoteHandleTransport {
	/** @returns false when the host link is down and the frame was dropped. */
	sendFrame(frame: HostClientFrame): boolean;
	rest<T>(path: string, init?: RequestInit): Promise<T>;
	onDisposed(sessionId: string): void;
}

export class RemoteSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	readonly agentId: string;
	private readonly transport: RemoteHandleTransport;
	private eventListeners = new Set<EventListener>();
	private uiListeners = new Set<UiFrameListener>();
	private planListeners = new Set<PlanFrameListener>();
	/** Deck-side subscriber refcount — drives host subscribe/unsubscribe frames. */
	private subscriberCount = 0;
	private snapshotCache: SessionSnapshot | undefined;
	private disposed = false;
	private streaming = false;
	private queueMirror: import("@omp-deck/protocol").QueuedPromptWire[] = [];
	private contextUsage: import("@omp-deck/protocol").ContextUsage | undefined;
	private planModeContext: import("@omp-deck/protocol").PlanModeContextWire | undefined;
	private pendingPlanApproval: import("@omp-deck/protocol").PendingPlanApprovalWire | undefined;

	constructor(args: {
		sessionId: string;
		cwd: string;
		agentId: string;
		transport: RemoteHandleTransport;
		onFirstSubscriber: () => void;
		onLastUnsubscriber: () => void;
	}) {
		this.sessionId = args.sessionId;
		this.cwd = args.cwd;
		this.agentId = args.agentId;
		this.transport = args.transport;
		this.onFirstSubscriber = args.onFirstSubscriber;
		this.onLastUnsubscriber = args.onLastUnsubscriber;
	}

	get sessionFile(): string | undefined {
		return undefined; // host-side path; not exposed
	}

	subscribe(listener: EventListener): () => void {
		this.eventListeners.add(listener);
		this.bumpSubscriber(+1);
		return () => {
			this.eventListeners.delete(listener);
			this.bumpSubscriber(-1);
		};
	}

	/** Called by the bridge for host `subscribed` snapshots. */
	applyHostSnapshot(snapshot: SessionSnapshot): void {
		this.snapshotCache = snapshot;
		this.streaming = snapshot.isStreaming;
		// Hydrate deck clients through the existing event channel.
		this.emitEvent({ type: "host_snapshot", snapshot } as unknown as import("@omp-deck/protocol").AgentSessionEventJson);
	}

	/** Called by the bridge for host session events + mirror bookkeeping. */
	applyHostEvent(event: import("@omp-deck/protocol").AgentSessionEventJson): void {
		switch (event.type) {
			case "context_usage":
				if ("contextUsage" in event && event.contextUsage) {
					this.contextUsage = event.contextUsage as import("@omp-deck/protocol").ContextUsage;
				}
				break;
			case "prompt_queued": {
				const entry: import("@omp-deck/protocol").QueuedPromptWire = {
					id: typeof event.queuedId === "string" ? event.queuedId : "",
					text: typeof event.text === "string" ? event.text : "",
					behavior: event.behavior === "steer" ? "steer" : "followUp",
					queuedAt: typeof event.queuedAt === "number" ? event.queuedAt : Date.now(),
				};
				if (Array.isArray(event.images) && event.images.length > 0) entry.images = event.images;
				this.queueMirror.push(entry);
				break;
			}
			case "queue_state":
				this.queueMirror = Array.isArray(event.queue) ? (event.queue as import("@omp-deck/protocol").QueuedPromptWire[]) : [];
				break;
			case "queue_cleared":
				this.queueMirror = [];
				break;
			case "turn_start":
				this.streaming = true;
				break;
			case "turn_end":
			case "agent_end":
				this.streaming = false;
				break;
			case "session_updated":
				if ("snapshot" in event && event.snapshot) {
					this.snapshotCache = event.snapshot as SessionSnapshot;
				}
				break;
			default:
				break;
		}
		this.emitEvent(event);
	}

	/** Called by the bridge for host plan-mode frames. */
	applyPlanFrame(frame: Extract<HostServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>): void {
		if (frame.type === "plan_mode_changed") {
			this.planModeContext = frame.enabled
				? { enabled: true, planFilePath: frame.planFilePath ?? "local://PLAN.md" }
				: undefined;
			if (!frame.enabled) this.pendingPlanApproval = undefined;
		} else if (frame.type === "plan_proposed") {
			this.pendingPlanApproval = {
				proposalId: frame.proposalId,
				planFilePath: frame.planFilePath,
				planContent: frame.planContent,
				suggestedTitle: frame.suggestedTitle,
				suggestedFinalPath: frame.suggestedFinalPath,
			};
		} else {
			this.pendingPlanApproval = undefined;
		}
		for (const listener of this.planListeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`remote plan listener threw`, err);
			}
		}
	}

	snapshot(): SessionSnapshot {
		return this.snapshotCache ?? {
			sessionId: this.sessionId,
			cwd: this.cwd,
			isStreaming: false,
			messages: [],
			todoPhases: [],
		};
	}

	getContextUsage(): import("@omp-deck/protocol").ContextUsage | undefined {
		return this.contextUsage;
	}

	isStreamingNow(): boolean {
		return this.streaming;
	}

	queuedMessageCount(): number {
		return this.queueMirror.length;
	}

	getQueueSnapshot(): import("@omp-deck/protocol").QueuedPromptWire[] {
		return [...this.queueMirror];
	}

	async prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void> {
		const ok = this.transport.sendFrame({
			type: "prompt",
			sessionId: this.sessionId,
			text,
			...(opts?.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : {}),
			...(opts?.images && opts.images.length > 0 ? { images: opts.images } : {}),
		});
		if (!ok) throw new Error(bridgeT("host connection is down; prompt not delivered"));
	}

	clearQueue(): { steering: number; followUp: number } {
		this.transport.sendFrame({ type: "clear_queue", sessionId: this.sessionId });
		const cleared = this.queueMirror.length;
		this.queueMirror = [];
		return { steering: cleared, followUp: 0 };
	}

	async cancelQueuedById(id: string): Promise<boolean> {
		this.transport.sendFrame({ type: "cancel_queued", sessionId: this.sessionId, queuedId: id });
		return true;
	}

	async editQueuedById(
		id: string,
		text: string,
		images?: ImageAttachment[],
	): Promise<boolean> {
		this.transport.sendFrame({
			type: "edit_queued",
			sessionId: this.sessionId,
			queuedId: id,
			text,
			...(images && images.length > 0 ? { images } : {}),
		});
		return true;
	}

	async abort(): Promise<void> {
		const ok = this.transport.sendFrame({ type: "abort", sessionId: this.sessionId });
		if (!ok) throw new Error(bridgeT("host connection is down; abort not delivered"));
	}

	async setName(name: string): Promise<void> {
		await this.transport.rest(`/host/sessions/${encodeURIComponent(this.sessionId)}/name`, {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	}

	async compact(focus?: string): Promise<void> {
		await this.transport.rest(`/host/sessions/${encodeURIComponent(this.sessionId)}/compact`, {
			method: "POST",
			body: JSON.stringify({ focus: focus ?? "" }),
		});
	}

	async setModel(ref: ModelRef): Promise<void> {
		await this.transport.rest(`/host/sessions/${encodeURIComponent(this.sessionId)}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: ref.provider, id: ref.id }),
		});
	}

	async dispatchSlashCommand(text: string): Promise<SlashDispatchResult> {
		const result = await this.transport.rest<SlashDispatchResult>(
			`/host/sessions/${encodeURIComponent(this.sessionId)}/slash-dispatch`,
			{ method: "POST", body: JSON.stringify({ text }) },
		);
		return result;
	}

	async dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult> {
		// Deck-owned slash registry (kanban ops etc.) runs HERE, on the deck's
		// own db — the host has no deck slash commands. Mirrors the local
		// handle's synthetic round-trip so the client sees the result.
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		let result: import("../deck-slash-commands.ts").DeckSlashResult | "fallthrough";
		try {
			result = await executeDeckSlashCommand(text, { cwd: this.cwd });
		} catch (err) {
			const message = bridgeT("Slash command error: {{detail}}", {
				detail: String((err as Error).message ?? err),
			});
			log.warn(`deck slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		if (result === "fallthrough") return { kind: "fallthrough" };
		const output = result.output || bridgeT("Done.");
		this.emitSyntheticSlashRoundTrip(text, output);
		return { kind: "consumed", output };
	}

	async setPlanMode(enabled: boolean): Promise<void> {
		this.transport.sendFrame({ type: "set_plan_mode", sessionId: this.sessionId, enabled });
	}

	getPlanModeContext(): import("@omp-deck/protocol").PlanModeContextWire | undefined {
		return this.planModeContext;
	}

	getPendingPlanApproval(): import("@omp-deck/protocol").PendingPlanApprovalWire | undefined {
		return this.pendingPlanApproval;
	}

	async respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		if (!this.pendingPlanApproval || this.pendingPlanApproval.proposalId !== proposalId) {
			return "unknown";
		}
		this.transport.sendFrame({
			type: "plan_response",
			sessionId: this.sessionId,
			proposalId,
			approved: response.approved,
			...(response.finalPath !== undefined ? { finalPath: response.finalPath } : {}),
			...(response.editedContent !== undefined ? { editedContent: response.editedContent } : {}),
		});
		return "settled";
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.eventListeners.clear();
		this.uiListeners.clear();
		this.planListeners.clear();
		try {
			await this.transport.rest(`/host/sessions/${encodeURIComponent(this.sessionId)}`, { method: "DELETE" });
		} catch (err) {
			log.warn(`remote dispose failed for ${this.sessionId}`, err);
		}
		this.transport.onDisposed(this.sessionId);
	}

	/** Bridge-facing UI-frame subscription (mirrors InProcessAgentBridge). */
	subscribeUiFrames(
		listener: (frame: Extract<HostServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>) => void,
	): () => void {
		this.uiListeners.add(listener);
		this.bumpSubscriber(+1);
		return () => {
			this.uiListeners.delete(listener);
			this.bumpSubscriber(-1);
		};
	}

	subscribePlanModeFrames(
		listener: (
			frame: Extract<HostServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>,
		) => void,
	): () => void {
		this.planListeners.add(listener);
		this.bumpSubscriber(+1);
		return () => {
			this.planListeners.delete(listener);
			this.bumpSubscriber(-1);
		};
	}

	/** Called by the bridge for host ext-ui frames. */
	applyUiFrame(frame: Extract<HostServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>): void {
		for (const listener of this.uiListeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`remote ui listener threw`, err);
			}
		}
	}

	/** Called by the bridge for host session-level errors. */
	applyHostError(message: string): void {
		this.emitEvent({ type: "error", error: message } as unknown as import("@omp-deck/protocol").AgentSessionEventJson);
	}

	// ─── internals ────────────────────────────────────────────────────────

	private onFirstSubscriber: () => void;
	private onLastUnsubscriber: () => void;

	private bumpSubscriber(delta: number): void {
		const wasZero = this.subscriberCount === 0;
		this.subscriberCount = Math.max(0, this.subscriberCount + delta);
		if (wasZero && this.subscriberCount > 0) this.onFirstSubscriber();
		else if (!wasZero && this.subscriberCount === 0) this.onLastUnsubscriber();
	}

	private emitEvent(event: import("@omp-deck/protocol").AgentSessionEventJson): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (err) {
				log.warn(`remote event listener threw`, err);
			}
		}
	}

	private emitSyntheticSlashRoundTrip(userText: string, assistantText: string): void {
		const now = Date.now();
		this.emitEvent({
			type: "message_start",
			message: { role: "user", content: userText, timestamp: now, synthetic: true },
		} as unknown as import("@omp-deck/protocol").AgentSessionEventJson);
		this.emitEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				timestamp: now,
				synthetic: true,
			},
		} as unknown as import("@omp-deck/protocol").AgentSessionEventJson);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// RemoteAgentBridge
// ─────────────────────────────────────────────────────────────────────────────

export class RemoteAgentBridge implements AgentBridge {
	private readonly registry: MachineRegistry;
	private readonly clients = new Map<string, HostClient>();
	private readonly sessions = new Map<string, RemoteSessionHandle>();
	/** Machine-side session file path → agentId, from the last listSessions. */
	private readonly pathToAgent = new Map<string, string>();

	constructor(registry: MachineRegistry) {
		this.registry = registry;
		for (const machine of registry.list()) {
			this.spawnClient(machine);
		}
	}

	async createSession(opts: CreateSessionOpts & { agentId: string }): Promise<SessionHandle> {
		const machine = this.registry.get(opts.agentId);
		if (!machine) throw new Error(i18n.t("unknown machine: {{id}}", { id: opts.agentId }));
		const client = this.ensureClient(machine);
		client.ensureOnline();
		const body: Record<string, unknown> = {
			cwd: opts.cwd,
			suppressAutoStart: opts.suppressAutoStart ?? false,
		};
		if (opts.model) body.model = { provider: opts.model.provider, id: opts.model.id };
		const resp = await client.rest<{ sessionId: string; cwd: string }>("/host/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const handle = new RemoteSessionHandle({
			sessionId: resp.sessionId,
			cwd: resp.cwd,
			agentId: opts.agentId,
			transport: {
				sendFrame: (frame) => client.send(frame),
				rest: (path, init) => client.rest(path, init),
				onDisposed: (sessionId) => {
					this.sessions.delete(sessionId);
				},
			},
			onFirstSubscriber: () => client.subscribeSession(resp.sessionId),
			onLastUnsubscriber: () => client.unsubscribeSession(resp.sessionId),
		});
		this.sessions.set(resp.sessionId, handle);
		return handle;
	}

	/**
	 * Resume a machine-side session file (path from the aggregated
	 * listSessions) as a live host session. Returns undefined when the path
	 * is not known to any machine (the local bridge should try it instead);
	 * throws when a known machine fails to resume.
	 */
	async tryResumeSession(opts: { sessionPath: string }): Promise<SessionHandle | undefined> {
		const agentId = this.pathToAgent.get(opts.sessionPath);
		if (!agentId) return undefined;
		const machine = this.registry.get(agentId);
		if (!machine) return undefined;
		const client = this.ensureClient(machine);
		client.ensureOnline();
		const body: Record<string, unknown> = { resumeFromPath: opts.sessionPath };
		const resp = await client.rest<{ sessionId: string; cwd: string }>("/host/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const handle = new RemoteSessionHandle({
			sessionId: resp.sessionId,
			cwd: resp.cwd,
			agentId,
			transport: {
				sendFrame: (frame) => client.send(frame),
				rest: (path, init) => client.rest(path, init),
				onDisposed: (sessionId) => {
					this.sessions.delete(sessionId);
				},
			},
			onFirstSubscriber: () => client.subscribeSession(resp.sessionId),
			onLastUnsubscriber: () => client.unsubscribeSession(resp.sessionId),
		});
		this.sessions.set(resp.sessionId, handle);
		return handle;
	}

	async resumeSession(opts: { sessionPath: string }): Promise<SessionHandle> {
		const handle = await this.tryResumeSession(opts);
		if (!handle) {
			throw new Error(i18n.t("resume is not supported on remote machines; create a new session instead"));
		}
		return handle;
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.sessions.get(sessionId);
	}

	async listSessions(opts: { cwd?: string } = {}): Promise<SessionSummary[]> {
		const out: SessionSummary[] = [];
		this.pathToAgent.clear();
		await Promise.all(
			this.registry.list().map(async (machine) => {
				try {
					const client = this.ensureClient(machine);
					const body = await client.rest<{ sessions: SessionSummary[] }>("/host/sessions");
					for (const s of body.sessions) {
						out.push({ ...s, agentId: machine.id, agentName: machine.name });
						if (s.path) this.pathToAgent.set(s.path, machine.id);
					}
				} catch (err) {
					log.warn(`listSessions failed for machine ${machine.id}`, err);
				}
			}),
		);
		if (!opts.cwd) return out;
		return out.filter((s) => s.cwd === opts.cwd);
	}

	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		// Refcount lives on the RemoteSessionHandle (all four ws.ts entry
		// points feed bumpSubscriber); nothing machine-level to do here.
		void connectionId;
		void sessionId;
	}

	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		void connectionId;
		void sessionId;
	}

	bumpActivity(_sessionId: string): void {
		// The host's reaper tracks activity on its side; nothing to do.
	}

	applyEnvUpdate(_update: RuntimeEnvUpdate): void {
		// Remote machine env is managed via the Machines API, not hot-pushed.
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<ModelInfo[]> {
		if (opts.sessionId) {
			const handle = this.sessions.get(opts.sessionId);
			if (!handle) return [];
			const client = this.clients.get(handle.agentId);
			if (!client) return [];
			const body = await client.rest<{ models: ModelInfo[] }>("/host/models");
			return body.models;
		}
		const out: ModelInfo[] = [];
		await Promise.all(
			this.registry.list().map(async (machine) => {
				try {
					const client = this.ensureClient(machine);
					const body = await client.rest<{ models: ModelInfo[] }>("/host/models");
					out.push(...body.models);
				} catch (err) {
					log.warn(`listModels failed for machine ${machine.id}`, err);
				}
			}),
		);
		return out;
	}

	subscribeUiFrames(
		sessionId: string,
		listener: (
			frame: Extract<HostServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>,
		) => void,
	): () => void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return () => {};
		return handle.subscribeUiFrames(listener);
	}

	respondToUiDialog(sessionId: string, dialogId: string, response: import("@omp-deck/protocol").ExtUiDialogResponse): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;
		const client = this.clients.get(handle.agentId);
		if (!client) return;
		client.send({
			type: "ext_ui_dialog_response",
			sessionId,
			dialogId,
			...response,
		} as HostClientFrame);
	}

	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<HostServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>,
		) => void,
	): () => void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return () => {};
		return handle.subscribePlanModeFrames(listener);
	}

	async respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		const handle = this.sessions.get(sessionId);
		if (!handle) return "unknown";
		return handle.respondToPlanApproval(proposalId, response);
	}

	async dispose(): Promise<void> {
		const disposals = Array.from(this.sessions.values()).map((h) =>
			h.dispose().catch((err) => log.warn(`remote session dispose failed`, err)),
		);
		await Promise.all(disposals);
		await Promise.all(Array.from(this.clients.values()).map((c) => c.dispose()));
		this.sessions.clear();
		this.clients.clear();
	}

	/** Machine CRUD hook: connect a newly registered machine. */
	addMachine(machine: MachineEntry): void {
		if (this.clients.has(machine.id)) return;
		this.spawnClient(machine);
	}

	/** Machine CRUD hook: drop a removed machine's connections + sessions. */
	removeMachine(id: string): void {
		const client = this.clients.get(id);
		if (client) {
			void client.dispose();
			this.clients.delete(id);
		}
		for (const [sessionId, handle] of this.sessions) {
			if (handle.agentId === id) {
				this.sessions.delete(sessionId);
				handle
					.dispose()
					.catch(() => {});
			}
		}
	}

	/** Live machine info for /api/machines. */
	machineStatus(): Array<{
		id: string;
		name: string;
		baseUrl: string;
		online: boolean;
		sessionCount: number;
		defaultCwd?: string;
	}> {
		return this.registry.list().map((m) => {
			const client = this.clients.get(m.id);
			let sessionCount = 0;
			for (const h of this.sessions.values()) {
				if (h.agentId === m.id) sessionCount += 1;
			}
			return {
				id: m.id,
				name: m.name,
				baseUrl: m.baseUrl,
				online: client?.online ?? false,
				sessionCount,
				...(m.defaultCwd ? { defaultCwd: m.defaultCwd } : {}),
			};
		});
	}

	// ─── internals ────────────────────────────────────────────────────────

	private ensureClient(machine: MachineEntry): HostClient {
		const existing = this.clients.get(machine.id);
		if (existing) return existing;
		const client = this.spawnClient(machine);
		return client;
	}

	private spawnClient(machine: MachineEntry): HostClient {
		const client = new HostClient(machine, (sessionId, frame) => this.routeFrame(sessionId, frame));
		this.clients.set(machine.id, client);
		client.start();
		return client;
	}

	private routeFrame(sessionId: string, frame: HostServerFrame): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) {
			// Session not tracked here (host reaped it, or the deck restarted).
			// Forward errors for unknown sessions to the frame's caller if it
			// matches a known session id; otherwise drop.
			if (frame.type === "session_disposed" || frame.type === "error") {
				log.debug(`frame for unknown remote session ${sessionId}: ${frame.type}`);
			}
			return;
		}
		switch (frame.type) {
			case "session_event":
				handle.applyHostEvent(frame.event);
				return;
			case "subscribed":
				handle.applyHostSnapshot(frame.snapshot);
				return;
			case "session_disposed":
				this.sessions.delete(sessionId);
				handle.applyHostError(`session disposed by host`);
				return;
			case "ext_ui_dialog_open":
			case "ext_ui_dialog_cancel":
				handle.applyUiFrame(frame);
				return;
			case "plan_mode_changed":
			case "plan_proposed":
			case "plan_proposal_resolved":
				handle.applyPlanFrame(frame);
				return;
			case "error":
				handle.applyHostError(frame.error);
				return;
			default:
				return;
		}
	}
}
