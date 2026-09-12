import { ModelRegistry, SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import type {
	AgentSessionEventJson,
	ExtUiDialogResponse,
	ModelInfo,
	ModelRef,
	ServerFrame,
	SessionSummary,
} from "@omp-deck/protocol";

import { executeDeckSlashCommand } from "../deck-slash-commands.ts";
import { logger } from "../log.ts";
import i18n from "../i18n.ts";
import { getDeckModelRegistry } from "../auth-singleton.ts";
import { getEffectivePrelude } from "../orientation-store.ts";
import { notificationService } from "../notifications/index.ts";
import {
	CoreSessionHandle,
	createCoreSession,
	isSubscriptionProvider,
	looksLikeAuthError,
	modelInfoFromSdk,
	summarizeSession,
} from "../../../agent-host/src/bridge/session-core.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	PlanApprovalResponse,
	ResumeSessionOpts,
	RuntimeEnvUpdate,
	SessionHandle,
	SlashDispatchResult,
} from "./types.ts";

const log = logger("bridge:in-process");

export { CoreSessionHandle as InProcessSessionHandle } from "../../../agent-host/src/bridge/session-core.ts";

/**
 * Deck-local bridge over the omp SDK. All session wiring (createAgentSession,
 * extension runner, event subscription, synthetic events, shadow queue,
 * plan-mode / extension-UI bridges) lives in the shared `session-core.ts`;
 * this class supplies the deck-specific context — prelude, deck slash
 * registry, model-registry singleton, notification hooks — plus the
 * subscriber/reaper lifecycle.
 */
interface Active {
	handle: CoreSessionHandle;
	session: AgentSession;
	unsubscribe: () => void;
	/** Wall-clock ms of the last user-visible activity on this session. */
	lastActivityAt: number;
	/** True between turn_start and turn_end — never reap mid-turn. */
	turnInFlight: boolean;
	/** Set of WS connection ids currently subscribed. Reaping requires zero subscribers. */
	subscribers: Set<string>;
}

export class InProcessAgentBridge implements AgentBridge {
	private active = new Map<string, Active>();
	private disposed = false;
	private reaperTimer: ReturnType<typeof setInterval> | null = null;
	private idleTimeoutMs: number;
	private readonly reapIntervalMs: number;
	private autoStartCommand: string | null;
	/** Prompts queued to fire as soon as the named session gets its first WS subscriber. */
	private pendingAutoPrompts = new Map<string, string>();
	/** Shared SDK model registry, lazily constructed on first session create. */
	private modelRegistry: ModelRegistry | undefined;
	private modelRegistryPromise: Promise<ModelRegistry> | undefined;

	constructor(opts: {
		idleTimeoutMs?: number;
		reapIntervalMs?: number;
		autoStartCommand?: string | null;
	} = {}) {
		this.idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60_000; // 15 min default
		this.reapIntervalMs = opts.reapIntervalMs ?? 60_000; // scan once a minute
		this.autoStartCommand = opts.autoStartCommand ?? "/start";
		if (this.idleTimeoutMs > 0) this.startReaper();
	}

	async createSession(opts: CreateSessionOpts): Promise<SessionHandle> {
		const sessionManager = SessionManager.create(opts.cwd);
		const modelRegistry = await this.ensureModelRegistry();
		const { handle, session, unsubscribe } = await createCoreSession({
			cwd: opts.cwd,
			sessionManager,
			modelRegistry,
			...(opts.model ? { model: opts.model } : {}),
			systemPrompt: (defaults) => [getEffectivePrelude(), ...defaults],
			hasUI: true,
			skipPythonPreflight: true,
			dispatchDeckSlash: (text) => this.dispatchDeckSlash(text, opts.cwd),
			onEvent: (sessionId, event) => this.trackActivity(sessionId, event),
			onNotice: (session, event) => this.handleAuthErrorNotice(session, event),
		});
		this.registerActive(handle, session, unsubscribe);
		if (!opts.suppressAutoStart && this.autoStartCommand) {
			this.pendingAutoPrompts.set(handle.sessionId, this.autoStartCommand);
		}
		log.info(`created session ${handle.sessionId} cwd=${opts.cwd}`);
		return handle;
	}

	async resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle> {
		const sessionManager = await SessionManager.open(opts.sessionPath);
		const cwd = (sessionManager.getCwd?.() as string | undefined) ?? process.cwd();
		const modelRegistry = await this.ensureModelRegistry();
		const { handle, session, unsubscribe } = await createCoreSession({
			cwd,
			sessionManager,
			modelRegistry,
			systemPrompt: (defaults) => [getEffectivePrelude(), ...defaults],
			hasUI: true,
			skipPythonPreflight: true,
			dispatchDeckSlash: (text) => this.dispatchDeckSlash(text, cwd),
			onEvent: (sessionId, event) => this.trackActivity(sessionId, event),
			onNotice: (session, event) => this.handleAuthErrorNotice(session, event),
		});
		this.registerActive(handle, session, unsubscribe);
		log.info(`resumed session ${handle.sessionId} from ${opts.sessionPath}`);
		return handle;
	}

	/** Deck slash registry dispatch (kanban ops etc.) — deck-only. */
	private async dispatchDeckSlash(text: string, cwd: string): Promise<SlashDispatchResult> {
		const result = await executeDeckSlashCommand(text, { cwd });
		return result === "fallthrough"
			? { kind: "fallthrough" }
			: { kind: "consumed", output: result.output };
	}

	/** Reaper activity tracking — mirrors the old attach() subscription tap. */
	private trackActivity(sessionId: string, event: AgentSessionEventJson): void {
		const entry = this.active.get(sessionId);
		if (!entry) return;
		entry.lastActivityAt = Date.now();
		if (event.type === "turn_start") entry.turnInFlight = true;
		else if (event.type === "turn_end" || event.type === "agent_end") entry.turnInFlight = false;
	}

	/** Issue #4 recovery hint — deck-only notification on auth-shaped notices. */
	private handleAuthErrorNotice(session: AgentSession, event: AgentSessionEventJson): void {
		const level = "level" in event ? event.level : undefined;
		const message = "message" in event ? event.message : undefined;
		if (level === "error" && typeof message === "string" && looksLikeAuthError(message)) {
			this.maybeSuggestSubscriptionFallback(session, message).catch((err) =>
				log.warn("subscription-fallback hint failed", err),
			);
		}
	}

	private registerActive(
		handle: CoreSessionHandle,
		session: AgentSession,
		unsubscribe: () => void,
	): void {
		this.active.set(handle.sessionId, {
			handle,
			session,
			unsubscribe,
			lastActivityAt: Date.now(),
			turnInFlight: false,
			subscribers: new Set(),
		});
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.active.get(sessionId)?.handle;
	}

	async listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		const raw = opts.cwd
			? await SessionManager.list(opts.cwd)
			: await SessionManager.listAll();
		return raw.map((r) => summarizeSession(r, "local"));
	}

	private ensureModelRegistry(): Promise<ModelRegistry> {
		if (this.modelRegistry) return Promise.resolve(this.modelRegistry);
		if (this.modelRegistryPromise) return this.modelRegistryPromise;
		this.modelRegistryPromise = (async () => {
			const registry = await getDeckModelRegistry();
			this.modelRegistry = registry;
			return registry;
		})();
		return this.modelRegistryPromise;
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<ModelInfo[]> {
		const registry = await this.ensureModelRegistry();
		const current = opts.sessionId ? this.active.get(opts.sessionId)?.handle.snapshot().model : undefined;
		return registry.getAll().map((model) => modelInfoFromSdk(model as unknown as never, registry, current));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = null;
		}
		log.info(`disposing ${this.active.size} active session(s)`);
		const disposals = Array.from(this.active.values()).map((a) =>
			a.handle.dispose().catch((err) => log.warn(`dispose failed`, err)),
		);
		await Promise.all(disposals);
		this.active.clear();
		this.pendingAutoPrompts.clear();
	}

	/** Called by the WS hub when a connection subscribes. Pin the session against the reaper. */
	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		const wasEmpty = a.subscribers.size === 0;
		a.subscribers.add(connectionId);
		a.lastActivityAt = Date.now();

		// First subscriber attached — flush any queued auto-prompt. Defer one
		// macrotask so the WS layer has flushed the `subscribed` snapshot frame
		// before the agent starts emitting `agent_start` / `message_*`.
		if (wasEmpty) {
			const pending = this.pendingAutoPrompts.get(sessionId);
			if (pending !== undefined) {
				this.pendingAutoPrompts.delete(sessionId);
				setTimeout(() => {
					a.handle.prompt(pending).catch((err) =>
						log.warn(`auto-start prompt failed for ${sessionId}`, err),
					);
				}, 50);
			}
		}
	}

	/** Called by the WS hub on unsubscribe / connection close. */
	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		a.subscribers.delete(connectionId);
		a.lastActivityAt = Date.now();
	}

	/** Bumps last-activity to now; called from prompt / abort / explicit access. */
	bumpActivity(sessionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		a.lastActivityAt = Date.now();
	}

	async listIdleSessions(idleMs: number): Promise<{ sessionId: string; lastActivityAt: number }[]> {
		const cutoff = Date.now() - idleMs;
		const out: { sessionId: string; lastActivityAt: number }[] = [];
		for (const [sessionId, a] of this.active) {
			if (a.lastActivityAt >= cutoff) continue;
			out.push({ sessionId, lastActivityAt: a.lastActivityAt });
		}
		return out;
	}

	applyEnvUpdate(update: RuntimeEnvUpdate): void {
		if (update.autoStartCommand !== undefined) {
			this.autoStartCommand = update.autoStartCommand;
			log.info(`hot-applied autoStartCommand`, { enabled: Boolean(update.autoStartCommand) });
		}
		if (update.idleTimeoutMs !== undefined && update.idleTimeoutMs !== this.idleTimeoutMs) {
			this.idleTimeoutMs = update.idleTimeoutMs;
			if (this.reaperTimer) {
				clearInterval(this.reaperTimer);
				this.reaperTimer = null;
			}
			if (this.idleTimeoutMs > 0) this.startReaper();
			log.info(`hot-applied idleTimeoutMs`, { idleTimeoutMs: this.idleTimeoutMs });
		}
	}

	private startReaper(): void {
		this.reaperTimer = setInterval(() => {
			this.reapIdle().catch((err) => log.warn(`reaper failed`, err));
		}, this.reapIntervalMs);
		// Don't keep the event loop alive for the timer alone.
		(this.reaperTimer as unknown as { unref?: () => void }).unref?.();
	}

	private async reapIdle(): Promise<void> {
		if (this.disposed) return;
		const now = Date.now();
		const cutoff = now - this.idleTimeoutMs;
		const candidates: Active[] = [];
		for (const a of this.active.values()) {
			if (a.turnInFlight) continue;
			if (a.subscribers.size > 0) continue;
			if (a.lastActivityAt > cutoff) continue;
			candidates.push(a);
		}
		if (candidates.length === 0) return;
		log.info(`reaping ${candidates.length} idle session(s)`);
		await Promise.all(
			candidates.map((a) =>
				a.handle.dispose().catch((err) => log.warn(`reap dispose failed`, err)),
			),
		);
	}

	// ─── Extension UI dialog bridge surface ──────────────────────────────

	subscribeUiFrames(
		sessionId: string,
		listener: (
			frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>,
		) => void,
	): () => void {
		const entry = this.active.get(sessionId);
		if (!entry) return () => {};
		// Replay any already-open dialogs to the late subscriber so a page
		// reload doesn't strand the user with an invisible blocking modal.
		const uiBridge = entry.handle.uiBridge;
		for (const frame of uiBridge.getPendingFrames()) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`pending UI frame replay threw`, err);
			}
		}
		return uiBridge.subscribeFrames(listener);
	}

	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void {
		const entry = this.active.get(sessionId);
		if (!entry) return;
		entry.handle.uiBridge.handleResponse(dialogId, response);
	}

	// ─── Plan-mode bridge surface ────────────────────────────────────────

	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }
			>,
		) => void,
	): () => void {
		const entry = this.active.get(sessionId);
		if (!entry) return () => {};
		// Replay current plan-mode state + any pending approval to the late
		// subscriber so a reconnect mid-approval re-renders the card instead
		// of waiting for the next event.
		const planBridge = entry.handle.planBridge;
		for (const frame of planBridge.getReplayFrames()) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`pending plan-mode frame replay threw`, err);
			}
		}
		return planBridge.subscribeFrames(listener);
	}

	async respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		const entry = this.active.get(sessionId);
		if (!entry) return "unknown";
		this.bumpActivity(sessionId);
		return entry.handle.planBridge.respond(proposalId, response);
	}

	/**
	 * Issue #4: emit a deck notification when an inline auth error on the
	 * current model has a known recovery path (subscription provider with
	 * the same model id is authenticated). Idempotent in the failure case —
	 * if any precondition is missing we just bail silently. The notification
	 * lands in the standard dropdown + optional OS toast so the operator
	 * sees it even if the chat is scrolled past the inline error.
	 */
	private async maybeSuggestSubscriptionFallback(
		session: AgentSession,
		errorMessage: string,
	): Promise<void> {
		const snap = (session as unknown as { snapshot?: () => { model?: { provider?: string; id?: string } } }).snapshot?.();
		const current = snap?.model;
		if (!current?.provider || !current.id) return;
		// Already on a subscription provider — nothing to suggest.
		if (isSubscriptionProvider(current.provider)) return;
		const registry = await this.ensureModelRegistry();
		// Look for any subscription provider carrying the same model id that's
		// authenticated (auth.db has OAuth credential).
		const alternative = registry
			.getAll()
			.map((m) => m as unknown as { id: string; provider: string | { toString(): string } })
			.find((m) => {
				if (m.id !== current.id) return false;
				const provider = String(m.provider);
				if (!isSubscriptionProvider(provider)) return false;
				return registry.isUsingOAuth(m as unknown as Parameters<ModelRegistry["isUsingOAuth"]>[0]);
			});
		if (!alternative) return;
		const altProvider = String(alternative.provider);
		await notificationService.notify({
			level: "warn",
			title: i18n.t("Authentication failed for {{provider}}/{{id}}", {
				provider: current.provider,
				id: current.id,
			}),
			body: i18n.t(
				"You appear to be authenticated for the same model under `{{provider}}` (subscription). Switch in the model picker to use your subscription instead.{{br}}Original error: {{error}}",
				{
					provider: altProvider,
					br: "\n\n",
					error: errorMessage.slice(0, 240),
				},
			),
			source: `bridge:auth-fallback`,
		});
	}
}


