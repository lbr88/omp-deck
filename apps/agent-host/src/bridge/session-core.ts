/**
 * Shared session wiring for the omp SDK, used by BOTH sides of the
 * multi-machine bridge:
 *
 *  1. The deck's `InProcessAgentBridge` (apps/server/src/bridge/in-process.ts)
 *     — local sessions, full deck context injected.
 *  2. The remote agent-host omp extension (apps/agent-host/src/index.ts) —
 *     nested sessions on a machine that only has the omp binary; deck-only
 *     facilities are omitted (no deck slash registry, no notifications, no
 *     deck i18n beyond the bridge-context default).
 *
 * Everything deck-specific arrives as injected options; this file must not
 * import any deck module (only `type` imports from `./types.ts` are allowed
 * — they are erased at runtime). Runtime imports are restricted to the omp
 * SDK (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`) and the dependency-
 * free siblings `./bridge-context.ts`, `./credential-quality.ts`,
 * `./ext-ui-bridge.ts`, `./plan-mode-bridge.ts` — the extension deployment
 * copies those four files alongside this one.
 */
import {
	createAgentSession,
	ModelRegistry,
	SessionManager,
	settings as ompSettings,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { runExtensionCompact, runExtensionSetModel } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ContextUsage,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	QueuedPromptWire,
	SessionSnapshot,
	SessionSummary,
} from "@omp-deck/protocol";

import { looksLikePlaceholderKey } from "../credential-quality.ts";
import { bridgeLog, bridgeT } from "./bridge-context.ts";
import { ExtensionUIBridge } from "./ext-ui-bridge.ts";
import type { PlanModeSessionSurface } from "./plan-mode-bridge.ts";
import { PlanModeBridge } from "./plan-mode-bridge.ts";

const log = bridgeLog("bridge:in-process");

// ─── Local contract types ─────────────────────────────────────────────────
// Structurally identical to bridge/types.ts (the deck's AgentBridge
// contract) but declared here so this file has zero relative imports beyond
// its copied siblings — the deployed extension layout cannot resolve a
// `./types.ts` shim pointing into the repo's apps/server tree.

export type SlashDispatchResult =
	| { kind: "fallthrough" }
	| { kind: "consumed"; output: string }
	| { kind: "rewritten"; output: string; prompt: string };

export type PlanApprovalResponse = {
	approved: boolean;
	/** Optional rename: `local://*.md`. When absent, uses the suggested final path. */
	finalPath?: string;
	/** Optional edited plan body. When present, overwrites `local://PLAN.md` before the rename. */
	editedContent?: string;
};

export type EventListener = (event: import("@omp-deck/protocol").AgentSessionEventJson) => void;

export interface SessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;
	subscribe(listener: EventListener): () => void;
	snapshot(): import("@omp-deck/protocol").SessionSnapshot;
	prompt(
		text: string,
		opts?: {
			streamingBehavior?: "steer" | "followUp";
			images?: import("@omp-deck/protocol").ImageAttachment[];
		},
	): Promise<void>;
	isStreamingNow(): boolean;
	queuedMessageCount(): number;
	clearQueue(): { steering: number; followUp: number };
	getQueueSnapshot(): import("@omp-deck/protocol").QueuedPromptWire[];
	cancelQueuedById(id: string): Promise<boolean>;
	editQueuedById(
		id: string,
		text: string,
		images?: import("@omp-deck/protocol").ImageAttachment[],
	): Promise<boolean>;
	abort(): Promise<void>;
	setName(name: string): Promise<void>;
	compact(focus?: string): Promise<void>;
	setModel(ref: import("@omp-deck/protocol").ModelRef): Promise<void>;
	dispatchSlashCommand(text: string): Promise<SlashDispatchResult>;
	dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult>;
	getContextUsage(): import("@omp-deck/protocol").ContextUsage | undefined;
	dispose(): Promise<void>;
	setPlanMode(enabled: boolean): Promise<void>;
	getPlanModeContext(): import("@omp-deck/protocol").PlanModeContextWire | undefined;
	getPendingPlanApproval(): import("@omp-deck/protocol").PendingPlanApprovalWire | undefined;
	respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
}

// `Model` is owned by `@oh-my-pi/pi-ai`, a transitive dep we don't bring in
// directly. Treat it as opaque at the bridge boundary — we only ever pass it
// back into the SDK's own methods.
export type SdkModel = {
	id: string;
	name?: string;
	provider: string | { toString(): string };
	contextWindow?: number;
	input?: unknown[];
};

// ─────────────────────────────────────────────────────────────────────────────
// createCoreSession
// ─────────────────────────────────────────────────────────────────────────────

export interface CoreSessionOptions {
	cwd: string;
	/** Resolve via the registry when present — a `ModelRef` ({provider,id}). */
	model?: ModelRef;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	/** Defaults to `(defaults) => defaults` — the deck injects its prelude here. */
	systemPrompt?: (defaults: string[]) => string[];
	/** Default true. Gates `ask`-tool registration; the deck UI counts as UI. */
	hasUI?: boolean;
	/** Default true — skip eval-tool Python warmup on session create. */
	skipPythonPreflight?: boolean;
	/**
	 * Deck-only: dispatch a leading slash through the deck's own command
	 * registry. Omitted on the host — `dispatchDeckSlashCommand` then
	 * returns `fallthrough` so the caller falls back to the SDK dispatcher.
	 */
	dispatchDeckSlash?: (text: string) => Promise<SlashDispatchResult>;
	/**
	 * Event tap invoked for every SDK event AND every synthetic event the
	 * core emits (context_usage / todo_phases_set / session_updated /
	 * prompt_queued / queue_state / queue_cleared / slash round-trips).
	 * The deck uses it for reaper activity tracking.
	 */
	onEvent?: (sessionId: string, event: AgentSessionEventJson) => void;
	/**
	 * Called for synthetic events only, before they reach handle listeners.
	 * The host uses it to forward synthetic frames to the deck without
	 * subscribing to every handle.
	 */
	onSynthetic?: (sessionId: string, event: AgentSessionEventJson) => void;
	/**
	 * Called for SDK `notice` events. The deck uses it for the issue-#4
	 * subscription-fallback notification; the host omits it.
	 */
	onNotice?: (session: AgentSession, event: AgentSessionEventJson) => void;
}

export interface CoreSessionResult {
	handle: CoreSessionHandle;
	session: AgentSession;
	uiBridge: ExtensionUIBridge;
	planBridge: PlanModeBridge;
	/** Unsubscribe the core's SDK event subscription. */
	unsubscribe: () => void;
}

/**
 * Create + fully wire an SDK agent session: extension runner callbacks,
 * per-session tool UI context, SDK event subscription with synthetic events,
 * shadow queue, plan-mode bridge, extension-UI bridge.
 */
export async function createCoreSession(opts: CoreSessionOptions): Promise<CoreSessionResult> {
	const sessionManager = opts.sessionManager;
	const modelRegistry = opts.modelRegistry;
	const result = await createAgentSession({
		cwd: opts.cwd,
		sessionManager,
		modelRegistry,
		authStorage: modelRegistry.authStorage,
		// Skip eval-tool Python warmup on session create. On Windows this otherwise
		// flashes a python.exe console window each turn-zero; on demand spawn is fine.
		skipPythonPreflight: opts.skipPythonPreflight ?? true,
		systemPrompt: opts.systemPrompt ?? ((defaults: string[]) => defaults),
		// Tell the SDK this session has a UI — gates the `ask` tool registration
		// and any extension that calls `ctx.ui.*`. The actual ExtensionUIContext
		// is installed via `setToolUIContext(...)` below.
		hasUI: opts.hasUI ?? true,
		// `opts.model` is a ModelRef ({provider,id}); the SDK's `model` option expects a
		// fully-shaped Model — resolve via the registry when present.
		...(opts.model
			? (() => {
					const m = modelRegistry.find(opts.model!.provider, opts.model!.id);
					return m ? { model: m } : {};
				})()
			: {}),
	});

	const session = result.session;
	const ext = result.extensionsResult;
	log.info(
		`createAgentSession: ${ext?.extensions?.length ?? 0} extensions loaded, ${ext?.errors?.length ?? 0} errors`,
		ext?.errors?.length ? ext.errors : undefined,
	);
	if (ext?.extensions?.length) {
		log.info(`extension paths: ${ext.extensions.map(e => (e as { path?: string }).path ?? "<unknown>").join(" | ")}`);
	}
	await wireExtensionRunner(session);

	const sessionId = session.sessionId;
	const uiBridge = new ExtensionUIBridge(sessionId);
	// Wire the per-session UI context into the SDK's tool-context store so
	// `AskTool.execute(...)` (and any extension calling `ctx.ui.*`) reaches
	// the deck UI via WebSocket frames.
	result.setToolUIContext(uiBridge, true);

	const planBridge = new PlanModeBridge({
		sessionId,
		session: session as unknown as PlanModeSessionSurface,
		getArtifactsDir: () => (sessionManager as unknown as { getArtifactsDir: () => string | null }).getArtifactsDir(),
		getSessionId: () => (sessionManager as unknown as { getSessionId: () => string | null }).getSessionId(),
	});

	const handle = new CoreSessionHandle({
		session,
		sessionManager,
		cwd: opts.cwd,
		sessionId,
		getModelRegistry: () => Promise.resolve(modelRegistry),
		uiBridge,
		planBridge,
		dispatchDeckSlash: opts.dispatchDeckSlash,
		onSyntheticEvent: opts.onSynthetic ? (event) => opts.onSynthetic!(sessionId, event) : undefined,
		onEvent: opts.onEvent ? (event) => opts.onEvent!(sessionId, event) : undefined,
		onDispose: () => {
			uiBridge.dispose();
			planBridge.dispose();
		},
	});

	// Bridge SDK events to handle's listeners, AND fire the synthetic events
	// the deck UI relies on (context utilization after turns/compaction,
	// todo phase trees after todo_write tool results).
	const unsubscribe = session.subscribe((event) => {
		const jsonEvent = event as unknown as AgentSessionEventJson;
		handle.onSdkEvent(jsonEvent);
		// After the SDK's own event reaches subscribers, fire a synthetic
		// `context_usage` event on the moments where the underlying number
		// changes: a turn finishing (fresh assistant usage now available)
		// or a compaction completing (post-compaction context shrunk).
		// `compaction_complete` is not part of the SDK's public event union —
		// widen to string so the legacy runtime match keeps working.
		const type: string = event.type;
		if (type === "turn_end" || type === "agent_end" || type === "compaction_complete") {
			const usage = handle.getContextUsage();
			if (usage) {
				handle.emitSynthetic({ type: "context_usage", contextUsage: usage } as unknown as AgentSessionEventJson);
			}
		}
		// Same pattern for todos: the SDK only fires `todo_reminder` on
		// reminder ticks (typically at turn boundaries), so the deck UI
		// shows stale todos between an agent's `todo_write` call and the
		// next reminder cycle. Synthesize `todo_phases_set` after each
		// todo_write tool result so the Inspector TodoPanel reflects the
		// current phase tree within the same tick (T-106).
		if (type === "tool_execution_end") {
			const toolName = getToolName(event);
			if (toolName === "todo_write") {
				const phases = (session as unknown as { getTodoPhases?: () => unknown[] }).getTodoPhases?.();
				if (Array.isArray(phases)) {
					handle.emitSynthetic({ type: "todo_phases_set", todoPhases: phases } as unknown as AgentSessionEventJson);
				}
			}
		}
		// Deck-specific hooks (issue #4 auth-fallback hint) — see onNotice.
		if (event.type === "notice") {
			opts.onNotice?.(session, jsonEvent);
		}
	});

	log.info(`created session ${sessionId} cwd=${opts.cwd}`);
	return { handle, session, uiBridge, planBridge, unsubscribe };
}

/** Read `toolName` off a `tool_execution_end` SDK event, when present. */
function getToolName(event: { type: string }): string | undefined {
	if (!("toolName" in event)) return undefined;
	const name = event.toolName;
	return typeof name === "string" ? name : undefined;
}

/**
 * Wire session-bound callbacks into the session's ExtensionRunner so the
 * lifecycle events fire and `pi.sendUserMessage` etc. reach the right
 * session. `createAgentSession` does extension *discovery* + runner
 * construction internally; the embedder is responsible for installing
 * the per-session callbacks afterward (mirrors task/executor.ts and
 * modes/acp/acp-agent.ts). Without this, loaded extensions are inert.
 */
async function wireExtensionRunner(session: AgentSession): Promise<void> {
	const runner = (session as unknown as { extensionRunner?: unknown }).extensionRunner as
		| {
				initialize: (actions: unknown, contextActions: unknown) => void;
				emit: (event: { type: string }) => Promise<void> | void;
				onError: (h: (e: { extensionPath?: string; error: unknown }) => void) => void;
		  }
		| undefined;
	if (!runner) return;

	// The extension-runner surface lives on the SDK class but is not part of
	// the public AgentSession type — duck-typed access behind one cast.
	const s = session as unknown as {
		sendCustomMessage: (msg: unknown, opts?: unknown) => Promise<void>;
		sendUserMessage: (content: unknown, opts?: unknown) => Promise<void>;
		sessionManager: {
			appendCustomEntry: (customType: string, data?: unknown) => string;
			appendLabelChange: (targetId: string, label: string) => void;
			getSessionName: () => string | undefined;
			setSessionName: (name: string, source: string) => Promise<void>;
		};
		getActiveToolNames: () => string[];
		getAllToolNames: () => string[];
		setActiveToolsByName: (names: string[]) => void;
		setModel: (model: unknown) => Promise<void>;
		modelRegistry: { getApiKey: (m: unknown) => Promise<string | undefined> };
		model: unknown;
		thinkingLevel: unknown;
		setThinkingLevel: (l: unknown) => void;
		isStreaming: boolean;
		abort: () => void;
		queuedMessageCount: number;
		getContextUsage: () => unknown;
		systemPrompt: unknown;
	};

	const actions = {
		sendMessage: (message: unknown, options?: unknown) => {
			s.sendCustomMessage(message, options).catch((err: unknown) => {
				log.warn(`extension sendMessage failed`, err);
			});
		},
		sendUserMessage: (content: unknown, options?: unknown) => {
			s.sendUserMessage(content, options).catch((err: unknown) => {
				log.warn(`extension sendUserMessage failed`, err);
			});
		},
		appendEntry: (customType: string, data?: unknown) => {
			return s.sessionManager.appendCustomEntry(customType, data);
		},
		setLabel: (targetId: string, label: string) => {
			s.sessionManager.appendLabelChange(targetId, label);
		},
		getActiveTools: () => s.getActiveToolNames(),
		getAllTools: () => s.getAllToolNames(),
		setActiveTools: (toolNames: string[]) => s.setActiveToolsByName(toolNames),
		getCommands: () => getSessionSlashCommands(s as never),
		setModel: (model: unknown) => runExtensionSetModel(s as never, model as never),
		getThinkingLevel: () => s.thinkingLevel,
		setThinkingLevel: (level: unknown) => s.setThinkingLevel(level),
		getSessionName: () => s.sessionManager.getSessionName(),
		setSessionName: async (name: string) => {
			await s.sessionManager.setSessionName(name, "user");
		},
	};

	const contextActions = {
		getModel: () => s.model,
		isIdle: () => !s.isStreaming,
		abort: () => s.abort(),
		hasPendingMessages: () => s.queuedMessageCount > 0,
		shutdown: () => {},
		getContextUsage: () => s.getContextUsage(),
		getSystemPrompt: () => s.systemPrompt,
		compact: (instructionsOrOptions: unknown) =>
			runExtensionCompact(s as never, instructionsOrOptions as never),
	};

	try {
		runner.initialize(actions, contextActions);
		runner.onError((err) => {
			log.warn(`extension error in ${err.extensionPath ?? "<unknown>"}`, err.error);
		});
		await runner.emit({ type: "session_start" });
		log.info(`extension runner wired for session`);
	} catch (err) {
		log.warn(`extension runner wiring failed`, err);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// CoreSessionHandle — full SessionHandle implementation over one SDK session
// ─────────────────────────────────────────────────────────────────────────────

export class CoreSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	/** Per-session extension-UI bridge (ask dialogs etc.) — owned by the core. */
	readonly uiBridge: ExtensionUIBridge;
	/** Per-session plan-mode bridge — owned by the core. */
	readonly planBridge: PlanModeBridge;
	private session: AgentSession;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistryRef: () => Promise<ModelRegistry>;
	/** Deck-only slash dispatch; omitted on the host. */
	private readonly deckSlashDispatch: ((text: string) => Promise<SlashDispatchResult>) | undefined;
	private readonly onSyntheticEvent: ((event: AgentSessionEventJson) => void) | undefined;
	private readonly onEvent: ((event: AgentSessionEventJson) => void) | undefined;
	private listeners = new Set<EventListener>();
	private onDisposeCallback: () => void;
	private disposed = false;
	/**
	 * Shadow of the SDK's pending-prompt queue. Entries are appended in
	 * `prompt()` when the SDK confirms a queue (wasStreaming = true) and
	 * removed in two ways:
	 *   - SDK drains the head as a new turn starts → caught in `emit()` on
	 *     the matching user `message_start` (matches by text, mirroring the
	 *     web reducer's drain rule).
	 *   - User explicitly cancels / edits via `cancelQueuedById` /
	 *     `editQueuedById` / `clearQueue`.
	 * The wire id (`queuedId` echoed in `prompt_queued`) is the same id used
	 * for cancel/edit targeting, so client and server agree without a
	 * separate id mapping table.
	 */
	private shadowQueue: QueuedPromptWire[] = [];

	constructor(args: {
		session: AgentSession;
		sessionManager: SessionManager;
		cwd: string;
		sessionId: string;
		getModelRegistry: () => Promise<ModelRegistry>;
		uiBridge: ExtensionUIBridge;
		planBridge: PlanModeBridge;
		dispatchDeckSlash?: (text: string) => Promise<SlashDispatchResult>;
		onSyntheticEvent?: (event: AgentSessionEventJson) => void;
		onEvent?: (event: AgentSessionEventJson) => void;
		onDispose: () => void;
	}) {
		this.session = args.session;
		this.sessionManager = args.sessionManager;
		this.cwd = args.cwd;
		this.sessionId = args.sessionId;
		this.modelRegistryRef = args.getModelRegistry;
		this.uiBridge = args.uiBridge;
		this.planBridge = args.planBridge;
		this.deckSlashDispatch = args.dispatchDeckSlash;
		this.onSyntheticEvent = args.onSyntheticEvent;
		this.onEvent = args.onEvent;
		this.onDisposeCallback = args.onDispose;
	}

	get sessionFile(): string | undefined {
		const s = this.session as unknown as { sessionFile?: string };
		return s.sessionFile;
	}

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Core-internal entry for SDK events: activity tap + fan-out. */
	onSdkEvent(event: AgentSessionEventJson): void {
		this.onEvent?.(event);
		this.emit(event);
	}

	/**
	 * Synthetic-event funnel: optional hooks first (host forwarding, bridge
	 * activity tracking), then normal listener fan-out. Synthetic events are
	 * the deck-generated frames (context_usage, todo_phases_set,
	 * session_updated, prompt_queued, queue_state, queue_cleared, slash
	 * round-trips) that the SDK itself never emits.
	 */
	emitSynthetic(event: AgentSessionEventJson): void {
		this.onSyntheticEvent?.(event);
		this.onEvent?.(event);
		this.emit(event);
	}

	emit(event: AgentSessionEventJson): void {
		this.maybeDrainShadowHead(event);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				log.warn(`listener failed`, err);
			}
		}
	}

	/**
	 * When the SDK starts a new turn it emits a `message_start` for the
	 * (non-synthetic) user message that triggered it. If that message text
	 * matches a shadowed queued prompt, the SDK drained it from the queue —
	 * pop the matching entry so the deck UI's queued-bubble disappears in
	 * lockstep with the real user bubble that appears.
	 *
	 * Match-by-text is brittle on duplicates but mirrors the web reducer's
	 * existing logic; the bridge keeps its shadow text aligned with the
	 * SDK-stored expansion (see `prompt()`) so slash-expanded prompts match.
	 */
	private maybeDrainShadowHead(event: AgentSessionEventJson): void {
		if (this.shadowQueue.length === 0) return;
		if (event.type !== "message_start") return;
		const message = getMessageStartPayload(event);
		if (!message || message.role !== "user" || message.synthetic) return;
		const text = extractMessageText(message.content);
		if (!text) return;
		const idx = this.shadowQueue.findIndex((q) => q.text === text);
		if (idx < 0) return;
		this.shadowQueue.splice(idx, 1);
		this.emitQueueState();
	}

	/**
	 * Broadcast the current shadow queue to subscribers so they can replace
	 * their local `queuedPrompts` wholesale. Used after cancel/edit/clear
	 * and on drain. Carries `null` for empty so the reducer can distinguish
	 * "queue actively empty" from "no state delivered yet".
	 */
	private emitQueueState(): void {
		// Direct fan-out — do NOT route through `emit()` or we'd recurse via
		// `maybeDrainShadowHead`.
		const frame = {
			type: "queue_state",
			queue: [...this.shadowQueue],
		} as unknown as AgentSessionEventJson;
		this.onSyntheticEvent?.(frame);
		this.onEvent?.(frame);
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`queue_state listener failed`, err);
			}
		}
	}

	snapshot(): SessionSnapshot {
		// Session snapshot fields live on the SDK class but not all of them on
		// the public AgentSession type — duck-typed read behind one cast.
		const s = this.session as unknown as {
			sessionName?: string;
			model?: unknown;
			thinkingLevel?: unknown;
			isStreaming?: boolean;
			messages?: unknown[];
			getTodoPhases?: () => unknown[];
		};
		const usage = this.getContextUsage();
		// SDK messages are structurally AgentMessageJson; the cast is the
		// protocol passthrough boundary (sanitized wire shape).
		const messages: AgentMessageJson[] = Array.isArray(s.messages) ? (s.messages as unknown as AgentMessageJson[]) : [];
		const snap: SessionSnapshot = {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			sessionName: typeof s.sessionName === "string" ? s.sessionName : undefined,
			cwd: this.cwd,
			model: sdkModelToRef(s.model),
			thinkingLevel: typeof s.thinkingLevel === "string" ? s.thinkingLevel : undefined,
			isStreaming: Boolean(s.isStreaming),
			messages,
			todoPhases:
				typeof s.getTodoPhases === "function"
					? (s.getTodoPhases() as unknown as Array<Record<string, unknown>>)
					: [],
		};
		if (usage) snap.contextUsage = usage;
		const planMode = this.planBridge.getPlanModeContext();
		if (planMode) snap.planMode = planMode;
		const pendingPlan = this.planBridge.getPendingPlanApproval();
		if (pendingPlan) snap.pendingPlanApproval = pendingPlan;
		if (this.shadowQueue.length > 0) snap.queuedPrompts = [...this.shadowQueue];
		return snap;
	}

	getContextUsage(): ContextUsage | undefined {
		// The SDK exposes `session.getContextUsage()` returning
		// `{ tokens: number | null, contextWindow: number, percent: number | null }`
		// or `undefined` when the model has no declared window. We pass it through
		// verbatim — the deck's protocol type mirrors the SDK shape.
		const s = this.session as unknown as { getContextUsage?: () => ContextUsage | undefined };
		if (typeof s.getContextUsage !== "function") return undefined;
		try {
			return s.getContextUsage();
		} catch (err) {
			log.warn(`getContextUsage threw`, err);
			return undefined;
		}
	}

	async compact(focus?: string): Promise<void> {
		// `session.compact(customInstructions?)` is the public SDK entry. The
		// SDK guards against concurrent compactions itself (throws "Compaction
		// already in progress") — we surface that error to the caller as-is so
		// the UI can show it.
		const s = this.session as unknown as { compact?: (customInstructions?: string) => Promise<unknown> };
		if (typeof s.compact !== "function") {
			throw new Error(bridgeT("session.compact is not available on this SDK build"));
		}
		await s.compact(focus && focus.trim().length > 0 ? focus.trim() : undefined);
	}

	async setModel(ref: ModelRef): Promise<void> {
		const registry = await this.modelRegistryRef();
		const model = registry.find(ref.provider, ref.id);
		if (!model) throw new Error(bridgeT("unknown model: {{provider}}/{{id}}", { provider: ref.provider, id: ref.id }));
		if (!registry.hasConfiguredAuth(model)) {
			throw new Error(bridgeT("no auth configured for {{provider}}/{{id}}", { provider: ref.provider, id: ref.id }));
		}
		const s = this.session as unknown as { setModel?: (model: unknown, role?: string) => Promise<void> };
		if (typeof s.setModel !== "function") {
			throw new Error(bridgeT("session.setModel is not available on this SDK build"));
		}
		await s.setModel(model);
		// Synthetic event so WS subscribers refresh the session header's model
		// label without waiting for the next assistant turn.
		this.emitSynthetic({ type: "session_updated", snapshot: this.snapshot() } as unknown as AgentSessionEventJson);
	}

	async dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult> {
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		if (!this.deckSlashDispatch) return { kind: "fallthrough" };
		let result: SlashDispatchResult;
		try {
			result = await this.deckSlashDispatch(text);
		} catch (err) {
			const message = bridgeT("Slash command error: {{detail}}", {
				detail: String((err as Error).message ?? err),
			});
			log.warn(`deck slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		if (result.kind === "fallthrough") return { kind: "fallthrough" };
		this.emitSyntheticSlashRoundTrip(text, result.output || bridgeT("Done."));
		return { kind: "consumed", output: result.output || bridgeT("Done.") };
	}

	async dispatchSlashCommand(text: string): Promise<SlashDispatchResult> {
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		const chunks: string[] = [];
		const runtime = {
			session: this.session,
			sessionManager: this.sessionManager,
			settings: ompSettings,
			cwd: this.cwd,
			output: (line: string) => {
				if (line) chunks.push(line);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		let result: unknown;
		try {
			result = await executeAcpBuiltinSlashCommand(text, runtime as unknown as Parameters<typeof executeAcpBuiltinSlashCommand>[1]);
		} catch (err) {
			const message = bridgeT("Slash command error: {{detail}}", {
				detail: String((err as Error).message ?? err),
			});
			log.warn(`slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		const output = chunks.join("\n").trim();
		if (result === false) return { kind: "fallthrough" };
		if (result && typeof result === "object" && "prompt" in result && typeof (result as { prompt: unknown }).prompt === "string") {
			this.emitSyntheticSlashRoundTrip(text, output || undefined);
			return { kind: "rewritten", output, prompt: (result as { prompt: string }).prompt };
		}
		const final = output || bridgeT("Done.");
		this.emitSyntheticSlashRoundTrip(text, final);
		return { kind: "consumed", output: final };
	}

	private emitSyntheticSlashRoundTrip(userText: string, assistantText: string | undefined): void {
		const now = Date.now();
		this.emitSynthetic({
			type: "message_start",
			message: {
				role: "user",
				content: userText,
				timestamp: now,
				synthetic: true,
			},
		} as unknown as AgentSessionEventJson);
		if (!assistantText) return;
		this.emitSynthetic({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				timestamp: now,
				synthetic: true,
			},
		} as unknown as AgentSessionEventJson);
	}

	async prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void> {
		// Snapshot the streaming flag BEFORE calling the SDK so we can tell
		// whether the SDK queued this prompt (was streaming) or ran it immediately.
		// The deck UI uses this to surface a "queued" bubble — without it, prompts
		// sent during streaming look like they vanished until the current turn ends.
		const wasStreaming = this.isStreamingNow();
		const behavior = (opts?.streamingBehavior ?? "followUp") as "steer" | "followUp";
		const promptOpts: Record<string, unknown> = {};
		if (opts?.streamingBehavior) promptOpts.streamingBehavior = opts.streamingBehavior;
		if (opts?.images && opts.images.length > 0) promptOpts.images = opts.images;
		await this.session.prompt(text, Object.keys(promptOpts).length > 0 ? (promptOpts as any) : undefined);
		if (wasStreaming) {
			const queuedId = crypto.randomUUID();
			// Align shadow text with whatever the SDK actually stored (post-
			// slash/template expansion) so head-drain matching survives expansion.
			// Falls back to the raw text when the SDK doesn't expose getQueuedMessages.
			const storedText = this.readLastQueuedText(behavior) ?? text;
			const entry: QueuedPromptWire = {
				id: queuedId,
				text: storedText,
				behavior,
				queuedAt: Date.now(),
			};
			if (opts?.images && opts.images.length > 0) entry.images = opts.images;
			this.shadowQueue.push(entry);
			this.emitSynthetic({
				type: "prompt_queued",
				queuedId,
				text: storedText,
				images: opts?.images,
				behavior,
				queueLength: this.queuedMessageCount(),
			} as unknown as AgentSessionEventJson);
			this.emitQueueState();
		}
	}

	isStreamingNow(): boolean {
		const s = this.session as unknown as { isStreaming?: boolean };
		return Boolean(s.isStreaming);
	}

	queuedMessageCount(): number {
		const s = this.session as unknown as { queuedMessageCount?: number };
		return typeof s.queuedMessageCount === "number" ? s.queuedMessageCount : 0;
	}

	getQueueSnapshot(): QueuedPromptWire[] {
		return [...this.shadowQueue];
	}

	clearQueue(): { steering: number; followUp: number } {
		const s = this.session as unknown as { clearQueue?: () => { steering: string[]; followUp: string[] } };
		if (typeof s.clearQueue !== "function") return { steering: 0, followUp: 0 };
		const dropped = s.clearQueue();
		const counts = { steering: dropped.steering.length, followUp: dropped.followUp.length };
		const hadShadow = this.shadowQueue.length > 0;
		this.shadowQueue = [];
		if (counts.steering + counts.followUp > 0) {
			this.emitSynthetic({
				type: "queue_cleared",
				cleared: counts,
			} as unknown as AgentSessionEventJson);
		}
		if (hadShadow) this.emitQueueState();
		return counts;
	}

	async cancelQueuedById(id: string): Promise<boolean> {
		const idx = this.shadowQueue.findIndex((q) => q.id === id);
		if (idx < 0) return false;
		await this.rebuildQueueExcept(idx, undefined);
		return true;
	}

	async editQueuedById(
		id: string,
		text: string,
		images?: ImageAttachment[],
	): Promise<boolean> {
		const idx = this.shadowQueue.findIndex((q) => q.id === id);
		if (idx < 0) return false;
		await this.rebuildQueueExcept(idx, { text, images });
		return true;
	}

	/**
	 * Rebuild the SDK queue by popping every entry and re-enqueueing
	 * survivors. When `replace` is undefined the entry at `targetIdx` is
	 * dropped (cancel); when set, its text/images are substituted in place
	 * (edit). Preserves order and the `queuedId` of every other entry so
	 * client bubbles don't flicker.
	 *
	 * Safety: the operation is only safe while a turn is in flight (queue is
	 * non-empty by precondition). The pop loop is synchronous so no
	 * microtasks can run mid-loop; the re-enqueue calls are kicked off
	 * synchronously (their sync prelude all observes `isStreaming = true`
	 * because the active turn is still streaming) and awaited in parallel.
	 */
	private async rebuildQueueExcept(
		targetIdx: number,
		replace: { text: string; images?: ImageAttachment[] } | undefined,
	): Promise<void> {
		const sdk = this.session as unknown as {
			popLastQueuedMessage?: () => string | undefined;
			isStreaming?: boolean;
		};
		if (typeof sdk.popLastQueuedMessage !== "function") {
			throw new Error(bridgeT("session.popLastQueuedMessage is not available on this SDK build"));
		}
		// Capture survivors with original ids preserved. The edited entry
		// keeps its id so the deck bubble doesn't re-key.
		const survivors: QueuedPromptWire[] = [];
		for (let i = 0; i < this.shadowQueue.length; i++) {
			const entry = this.shadowQueue[i]!;
			if (i === targetIdx) {
				if (!replace) continue;
				const next: QueuedPromptWire = {
					id: entry.id,
					text: replace.text,
					behavior: entry.behavior,
					queuedAt: entry.queuedAt,
				};
				if (replace.images && replace.images.length > 0) next.images = replace.images;
				survivors.push(next);
			} else {
				survivors.push(entry);
			}
		}
		// Synchronously drain the SDK queue. popLastQueuedMessage is sync;
		// no microtask boundary inside this loop.
		while (this.queuedMessageCount() > 0) {
			sdk.popLastQueuedMessage();
		}
		// Kick off re-enqueues synchronously so each `session.prompt` sync
		// prelude sees `isStreaming = true`. Collect promises; await later.
		const promises: Promise<void>[] = [];
		for (const entry of survivors) {
			const opts: Record<string, unknown> = { streamingBehavior: entry.behavior };
			if (entry.images && entry.images.length > 0) opts.images = entry.images;
			promises.push(this.session.prompt(entry.text, opts as any));
		}
		this.shadowQueue = survivors;
		try {
			await Promise.all(promises);
			// Re-align text against the SDK's post-expansion store, by bucket.
			const bucketed = this.readQueuedTextsByBehavior();
			let stIdx = 0;
			let fuIdx = 0;
			for (const s of this.shadowQueue) {
				const bucket = s.behavior === "steer" ? bucketed.steering : bucketed.followUp;
				const i = s.behavior === "steer" ? stIdx++ : fuIdx++;
				const actual = bucket[i];
				if (typeof actual === "string") s.text = actual;
			}
		} catch (err) {
			log.warn(`re-enqueue after queue manipulation failed`, err);
			// Shadow may be ahead of reality; resync from SDK as best-effort.
			this.shadowQueue = this.resyncShadowFromSdk(this.shadowQueue);
		}
		this.emitQueueState();
	}

	private readLastQueuedText(behavior: "steer" | "followUp"): string | undefined {
		const sdk = this.session as unknown as { getQueuedMessages?: () => { steering: string[]; followUp: string[] } };
		if (typeof sdk.getQueuedMessages !== "function") return undefined;
		const q = sdk.getQueuedMessages();
		const bucket = behavior === "steer" ? q.steering : q.followUp;
		return bucket[bucket.length - 1];
	}

	private readQueuedTextsByBehavior(): { steering: string[]; followUp: string[] } {
		const sdk = this.session as unknown as { getQueuedMessages?: () => { steering: string[]; followUp: string[] } };
		if (typeof sdk.getQueuedMessages !== "function") return { steering: [], followUp: [] };
		return sdk.getQueuedMessages();
	}

	/**
	 * Last-ditch resync: if a queue manipulation lost track, rebuild the
	 * shadow from the SDK's text-only view. Re-uses caller-supplied ids
	 * positionally (steering bucket first, then followUp) so most bubbles
	 * keep their id; any extras get a fresh uuid.
	 */
	private resyncShadowFromSdk(previous: QueuedPromptWire[]): QueuedPromptWire[] {
		const q = this.readQueuedTextsByBehavior();
		const ordered: { text: string; behavior: "steer" | "followUp" }[] = [];
		for (const t of q.steering) ordered.push({ text: t, behavior: "steer" });
		for (const t of q.followUp) ordered.push({ text: t, behavior: "followUp" });
		const out: QueuedPromptWire[] = [];
		for (let i = 0; i < ordered.length; i++) {
			const prev = previous[i];
			const e = ordered[i]!;
			out.push({
				id: prev?.id ?? crypto.randomUUID(),
				text: e.text,
				behavior: e.behavior,
				queuedAt: prev?.queuedAt ?? Date.now(),
				...(prev?.images ? { images: prev.images } : {}),
			});
		}
		return out;
	}

	async abort(): Promise<void> {
		// The SDK's `abort()` cancels the in-flight turn but leaves the followUp
		// queue intact, which surprises users — they pressed Stop expecting
		// "stop everything". Mirror the user intent: drop the queue first, then
		// abort. The clearQueue() emits its own `queue_cleared` event so the
		// deck UI reconciles its `queuedPrompts` list.
		this.clearQueue();
		await this.session.abort();
	}

	async setName(name: string): Promise<void> {
		// The omp SDK signature is `setSessionName(name, source?: "auto" | "user")`
		// and defaults `source` to `"auto"`. Auto-titled names are silently
		// overwritten the next time the input-controller's title generator fires
		// (typically after the first agent turn completes), so a user-supplied
		// rename made before that point would disappear once `/start` finishes.
		// Pass `"user"` so the name takes permanent precedence per SDK contract.
		const s = this.session as unknown as { setSessionName?: (n: string, source?: "auto" | "user") => Promise<boolean> | boolean };
		if (typeof s.setSessionName !== "function") {
			throw new Error(bridgeT("session.setSessionName is not available on this SDK build"));
		}
		const accepted = await s.setSessionName(name, "user");
		if (accepted === false) {
			throw new Error(
				bridgeT("session rejected name (empty after sanitization?): {{detail}}", {
					detail: JSON.stringify(name),
				}),
			);
		}
	}

	// ─── Plan-mode bridge surface ────────────────────────────────────────

	async setPlanMode(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.planBridge.enter();
		} else {
			await this.planBridge.exit("user_cancelled");
		}
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		return this.planBridge.getPlanModeContext();
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		return this.planBridge.getPendingPlanApproval();
	}

	async respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		return this.planBridge.respond(proposalId, response);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		try {
			await this.session.dispose();
		} catch (err) {
			log.warn(`session.dispose threw`, err);
		}
		this.onDisposeCallback();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Session summary / model listing helpers (shared deck + host)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a SessionManager.list / listAll record into our SessionSummary. */
export function summarizeSession(raw: unknown, agentId: string, agentName?: string): SessionSummary {
	const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const header = typeof source.header === "object" && source.header !== null ? (source.header as Record<string, unknown>) : undefined;
	const id = String(source.id ?? source.sessionId ?? header?.id ?? "");
	const filePath = String(source.path ?? source.file ?? source.sessionFile ?? "");
	const cwd = String(source.cwd ?? header?.cwd ?? "");
	const title =
		typeof source.title === "string"
			? source.title
			: typeof header?.title === "string"
				? header.title
				: undefined;
	// SDK 15 records use `timestamp`/`modifiedAt`; SDK 17 uses `created`/
	// `modified` (Date instances). Normalize both to ISO strings.
	const createdAt = toIsoString(source.timestamp ?? source.createdAt ?? source.created ?? header?.timestamp ?? "");
	const updatedAt = toIsoString(source.modifiedAt ?? source.updatedAt ?? source.modified ?? createdAt);
	const messageCount = Number(source.messageCount ?? source.count ?? 0);
	return {
		id,
		path: filePath,
		cwd,
		title,
		createdAt,
		updatedAt,
		messageCount,
		agentId,
		...(agentName ? { agentName } : {}),
	};
}

/**
 * Provider IDs that represent a true consumer subscription — the user
 * paid a monthly fee (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, Cursor)
 * or a coding plan (Z.AI GLM, Alibaba, MiniMax, Kimi). The picker badges
 * these so users can tell subscription variants apart from API-key
 * variants of the same model name (the actual bug from issue #4).
 *
 * Intentionally an explicit allowlist, not `getOAuthProviders()` from the
 * SDK. The SDK's "OAuth providers" is a broader category that also
 * includes local runtimes (Ollama, LM Studio, vLLM), gateway services
 * (LiteLLM, Kilo, Cloudflare AI Gateway), and pure-API-tier providers
 * (Cerebras, Fireworks, Together, HuggingFace) — none of which are
 * "subscriptions" in the user-facing sense. Calling Ollama a
 * "subscription" in the model picker is actively misleading.
 *
 * Used for two purposes by `modelInfoFromSdk` and the issue-#4 hint:
 *   - Tag rows with `isSubscription: true` so the picker can badge them.
 *   - Pick recovery targets for the 401-fallback notification.
 *
 * When the SDK adds a new subscription-style provider, add it here.
 * False negatives (missing a real subscription) are graceful — the user
 * just doesn't get the badge. False positives (claiming Ollama is a
 * subscription) are confusing and that's what we're fixing here.
 */
const SUBSCRIPTION_PROVIDER_IDS: Record<string, true> = {
	anthropic: true, // Claude Pro/Max — competes with anthropic API key for Claude models
	"openai-codex": true, // ChatGPT Plus/Pro — competes with openai API key for gpt-5/etc.
	"github-copilot": true, // Copilot subscription
	cursor: true, // Cursor IDE subscription — surfaces Claude/GPT models
	perplexity: true, // Perplexity Pro/Max — competes with perplexity API key
	"alibaba-coding-plan": true, // Alibaba Coding Plan
	zai: true, // Z.AI GLM Coding Plan
	"minimax-code": true, // MiniMax Coding Plan (International)
	"minimax-code-cn": true, // MiniMax Coding Plan (China)
	"kimi-code": true, // Kimi Code
	"google-antigravity": true, // Google Antigravity (preview)
};

export function isSubscriptionProvider(providerId: string): boolean {
	return SUBSCRIPTION_PROVIDER_IDS[providerId] === true;
}

/**
 * Heuristic match for "this error is an auth failure on the API call we
 * just made". Used to gate the issue-#4 subscription-fallback hint. Kept
 * narrow on purpose: false positives mean we suggest a switch when none is
 * needed, which is annoying; the worst case is silence on a less-common
 * error shape, which is the existing behavior.
 */
export function looksLikeAuthError(message: string): boolean {
	const m = message.toLowerCase();
	if (m.includes("401")) return true;
	if (m.includes("incorrect api key")) return true;
	if (m.includes("invalid api key")) return true;
	if (m.includes("invalid_api_key")) return true;
	if (m.includes("unauthorized")) return true;
	if (m.includes("authentication failed")) return true;
	if (m.includes("api key is required")) return true;
	return false;
}

export function modelInfoFromSdk(
	model: SdkModel,
	registry: ModelRegistry,
	current: { provider: string; id: string } | undefined,
): ModelInfo {
	const provider = String(model.provider);
	const sdkModel = model as unknown as Parameters<ModelRegistry["hasConfiguredAuth"]>[0];
	const hasAuth = registry.hasConfiguredAuth(sdkModel);
	const usingOAuth = registry.isUsingOAuth(sdkModel);
	const isSubscription = isSubscriptionProvider(provider);
	// `isAvailable` semantics: would a call routed to this provider succeed?
	//   - SDK reports no configured auth at all → false (keyless paths are
	//     also flagged via hasConfiguredAuth, so this also covers them).
	//   - SDK has an OAuth credential in auth.db (`isUsingOAuth`) → true,
	//     regardless of what's in process.env.
	//   - Otherwise an env-var API key is the credential source. Validate
	//     that the value isn't a known placeholder (`sk-your-…here`, etc.)
	//     — see credential-quality.ts and issue #4.
	let isAvailable = hasAuth;
	if (isAvailable && !usingOAuth) {
		const envValue = getEnvApiKey(provider);
		// Only suppress when the env-var IS the credential. An empty env var
		// with `hasConfiguredAuth=true` means auth came from somewhere else
		// (auth.db non-OAuth entry, keyless provider, foundry, etc.) — trust
		// the SDK in that case.
		if (envValue && looksLikePlaceholderKey(envValue)) {
			isAvailable = false;
		}
	}
	const info: ModelInfo = {
		provider,
		id: model.id,
		label: model.name || model.id,
		isAvailable,
	};
	if (isSubscription) info.isSubscription = true;
	if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
		info.contextWindow = model.contextWindow;
	}
	if (Array.isArray(model.input) && model.input.length > 0) {
		info.inputModes = model.input.filter((m: unknown): m is "text" | "image" => m === "text" || m === "image");
	}
	if (current && current.provider === info.provider && current.id === info.id) {
		info.isCurrent = true;
	}
	return info;
}

/**
 * Extract the user-visible text from an SDK user-message `content` field.
 * Mirrors the shape variations the SDK emits: plain string, an array of
 * blocks like `{type:"text", text}`, or an object with a `.text` field.
 * Returns the empty string when nothing text-like is present (e.g.
 * image-only message).
 */
export function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const b = block as { type?: string; text?: unknown };
				if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			}
		}
		return parts.join("");
	}
	if (content && typeof content === "object") {
		const c = content as { text?: unknown };
		if (typeof c.text === "string") return c.text;
	}
	return "";
}

/** Stringify a timestamp that may be an ISO string, a Date, or a number. */
function toIsoString(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return new Date(value).toISOString();
	return String(value ?? "");
}

/** Narrow an SDK model object down to a `{provider,id}` ref with runtime checks. */
function sdkModelToRef(model: unknown): { provider: string; id: string } | undefined {
	if (!model || typeof model !== "object") return undefined;
	if (!("provider" in model) || !("id" in model)) return undefined;
	const provider = model.provider;
	const id = model.id;
	if (provider === undefined || id === undefined) return undefined;
	return { provider: String(provider), id: String(id) };
}

/** Narrow a `message_start` event's message payload with runtime checks. */
function getMessageStartPayload(
	event: AgentSessionEventJson,
): { role?: string; content?: unknown; synthetic?: boolean } | undefined {
	if (!("message" in event)) return undefined;
	const message = event.message;
	if (!message || typeof message !== "object") return undefined;
	return message as { role?: string; content?: unknown; synthetic?: boolean };
}
