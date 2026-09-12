/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode.#enterPlanMode` lifecycle on top of
 * the deck's WebSocket protocol:
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot active tools, splice in `resolve` if missing
 *      - `setActiveToolsByName(planTools)`
 *      - `setPlanModeState({ enabled, planFilePath, workflow })`
 *      - `setStandingResolveHandler(#handlePlanResolve)`
 *      - broadcast `plan_mode_changed{enabled:true}`
 *
 *   2. Agent works under plan-mode restrictions (SDK's
 *      `#enforcePlanModeToolDecision` blocks writes via the system
 *      prompt + tool-decision intercept), writes `local://PLAN.md`,
 *      calls `resolve apply`. The SDK invokes our standing handler
 *      via `runResolveInvocation`.
 *
 *   3. `#handlePlanResolve`'s `apply` callback:
 *      - validates plan-mode is still active
 *      - reads the plan file via `local://` resolver
 *      - derives a title via `resolvePlanTitle` (handles issue #1179
 *        empty-`extra.title` corner case)
 *      - broadcasts `plan_proposed` to the deck UI
 *      - **blocks** on a Promise the deck UI settles via
 *        `plan_response` → `respond(proposalId, response)`
 *
 *   4. On approve: write edited content (if any), rename PLAN.md to
 *      the title-derived final path, exit plan mode (restoring the
 *      previous tool set + clearing handler + clearing SDK state),
 *      and queue the SDK's `planModeApprovedPrompt` as a follow-up
 *      so the next turn executes the plan with full tools.
 *
 *   5. On reject: exit plan mode and surface a clear rejection
 *      message to the agent.
 *
 *   6. On cancel (user toggles plan mode off mid-approval) or session
 *      dispose: reject the pending promise so the resolve tool
 *      returns with an error the agent can recover from.
 *
 * SDK reference impl: `@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts`
 * (`#enterPlanMode`, `#runPlanApprovalResolve`, `#exitPlanMode`,
 * `#approvePlan`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	type PlanApprovalDetails,
	resolvePlanTitle,
} from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type {
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
} from "@omp-deck/protocol";

import type { PlanApprovalResponse } from "./session-core.ts";

import { bridgeLog, bridgeT } from "./bridge-context.ts";

const log = bridgeLog("bridge:plan-mode");

/** Canonical plan file URL. The SDK's `resolve` tool, the TUI, and the
 *  plan-mode system prompt all use this exact path; do not vary per-session. */
const PLAN_FILE_URL = "local://PLAN.md";

/** Tool the SDK requires for plan-mode submission. Spliced into the active
 *  tool set on enter if it isn't already there. */
const RESOLVE_TOOL = "resolve";

/** Workflow flavor passed to `setPlanModeState`. MVP only supports
 *  `"parallel"`; `"iterative"` (TUI-only) is explicitly out of scope. */
const PLAN_WORKFLOW = "parallel" as const;

/**
 * Pre-rendered companion to
 * `@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md`
 * with the deck's fixed branches baked in:
 *   - `contextPreserved: true` (deck never compacts at the plan boundary;
 *     deferred to v1.1 — see design doc §"open questions" #2)
 *   - `tools` includes `todo_write` (deck's session tool set always has it)
 *
 * Inlined because the SDK's `exports` map doesn't expose `.md` assets, and
 * we want a stable contract that's visible alongside the lifecycle code
 * rather than a fragile runtime fetch. **Mirror SDK changes here on
 * upgrade.** Diff against the upstream file when bumping
 * `@oh-my-pi/pi-coding-agent`.
 */
const PLAN_APPROVED_PROMPT_TEMPLATE = `<critical>
Plan approved. You MUST execute it now.
</critical>

Finalized plan artifact: \`{{finalPlanFilePath}}\`
Context preserved. Use conversation history when useful; the finalized plan is the source of truth if it conflicts with earlier exploration.

## Plan

{{planContent}}

<instruction>
You MUST execute this plan step by step from \`{{finalPlanFilePath}}\`. You have full tool access.
You MUST verify each step before proceeding to the next.
Before execution, initialize todo tracking with \`todo_write\`.
After each completed step, immediately update \`todo_write\`.
If \`todo_write\` fails, fix the payload and retry before continuing.
</instruction>

<critical>
You MUST keep going until complete. This matters.
</critical>
`;

type PlanModeChangedFrame = Extract<ServerFrame, { type: "plan_mode_changed" }>;
type PlanProposedFrame = Extract<ServerFrame, { type: "plan_proposed" }>;
type PlanProposalResolvedFrame = Extract<ServerFrame, { type: "plan_proposal_resolved" }>;
export type PlanModeFrame = PlanModeChangedFrame | PlanProposedFrame | PlanProposalResolvedFrame;

type FrameListener = (frame: PlanModeFrame) => void;

interface PendingApproval {
	proposalId: string;
	planFilePath: string;
	planContent: string;
	suggestedTitle: string;
	suggestedFinalPath: string;
	resolve: (resp: PlanApprovalResponse) => void;
	reject: (err: Error) => void;
}

/**
 * Minimal `AgentSession` surface this bridge needs. Listed here as a
 * structural interface so tests can substitute a hand-rolled fake without
 * spinning up the full SDK.
 */
export interface PlanModeSessionSurface {
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	setPlanModeState(state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined): void;
	setStandingResolveHandler(
		handler: ((input: unknown) => Promise<unknown> | unknown) | null,
	): void;
	/**
	 * SDK 17+: plan approval rides the `write xd://propose <title>` device;
	 * the session dispatches the title to this handler. Absent on SDK 15.
	 */
	setPlanProposalHandler?(handler: ((title: string) => Promise<unknown>) | null): void;
	/** SDK 17+: pin the approved plan path for reference-message bookkeeping. */
	setPlanReferencePath?(planFilePath: string): void;
	/** SDK 17+: whether a built-in tool name exists (plan-mode write augmentation). */
	hasBuiltInTool?(name: string): boolean;
	markPlanReferenceSent(): void;
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
}

export interface PlanModeBridgeArgs {
	sessionId: string;
	session: PlanModeSessionSurface;
	/** SDK `sessionManager.getArtifactsDir()` — feeds `local://` resolution. */
	getArtifactsDir: () => string | null;
	/** SDK `sessionManager.getSessionId()` — feeds `local://` resolution. */
	getSessionId: () => string | null;
}

/** Bridge over the SDK's plan-mode primitives, scoped to one session. */
/**
 * SDK 15's `ResolveToolDetails` result shape, declared locally so the
 * resolve path doesn't need the version-gated type import.
 */
interface ResolveToolDetailsWire {
	action: "apply" | "discard";
	reason: string;
	sourceToolName?: string;
	label?: string;
	extra?: Record<string, unknown>;
	sourceResultDetails?: unknown;
}

export class PlanModeBridge {
	private readonly sessionId: string;
	private readonly session: PlanModeSessionSurface;
	private readonly getArtifactsDir: () => string | null;
	private readonly getSessionId: () => string | null;
	private readonly listeners = new Set<FrameListener>();
	private nextProposalCounter = 1;
	private enabled = false;
	private planFilePath: string = PLAN_FILE_URL;
	private previousTools: string[] = [];
	private pendingApproval: PendingApproval | undefined;
	private disposed = false;
	/**
	 * SDK 17+ exposes `setPlanProposalHandler` (xd://propose device) instead
	 * of SDK 15's `setStandingResolveHandler` + `runResolveInvocation`.
	 * Feature-detected at construction; both paths share the approval UI.
	 */
	private readonly sdk17: boolean;

	constructor(args: PlanModeBridgeArgs) {
		this.sessionId = args.sessionId;
		this.session = args.session;
		this.getArtifactsDir = args.getArtifactsDir;
		this.getSessionId = args.getSessionId;
		this.sdk17 = typeof args.session.setPlanProposalHandler === "function";
	}

	// ─── Snapshot + replay surface (consumed by InProcessAgentBridge) ─────

	isEnabled(): boolean {
		return this.enabled;
	}

	hasPendingApproval(): boolean {
		return this.pendingApproval !== undefined;
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		if (!this.enabled) return undefined;
		return { enabled: true, planFilePath: this.planFilePath };
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		const p = this.pendingApproval;
		if (!p) return undefined;
		return {
			proposalId: p.proposalId,
			planFilePath: p.planFilePath,
			planContent: p.planContent,
			suggestedTitle: p.suggestedTitle,
			suggestedFinalPath: p.suggestedFinalPath,
		};
	}

	/** Replay frames sent verbatim to a late subscriber so a page-reload
	 *  during plan mode immediately re-renders the pill + any open card. */
	getReplayFrames(): PlanModeFrame[] {
		const out: PlanModeFrame[] = [];
		if (this.enabled) {
			out.push({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: true,
				planFilePath: this.planFilePath,
			});
		}
		const p = this.pendingApproval;
		if (p) {
			out.push({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId: p.proposalId,
				planFilePath: p.planFilePath,
				planContent: p.planContent,
				suggestedTitle: p.suggestedTitle,
				suggestedFinalPath: p.suggestedFinalPath,
			});
		}
		return out;
	}

	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	/** Enter plan mode. Idempotent — re-entry is a no-op. */
	async enter(): Promise<void> {
		if (this.disposed || this.enabled) return;

		const previousTools = this.session.getActiveToolNames();
		if (this.sdk17) {
			// SDK 17: plan approval rides the `write xd://propose <title>`
			// device, so the tool set is augmented with `write` (when missing)
			// and the propose handler is installed instead of a resolve handler.
			const writeMissing =
				typeof this.session.hasBuiltInTool === "function" &&
				this.session.hasBuiltInTool("write") &&
				!previousTools.includes("write");
			const planTools = writeMissing ? [...previousTools, "write"] : previousTools;
			if (planTools !== previousTools) {
				await this.session.setActiveToolsByName(planTools);
			}
			this.previousTools = previousTools;
			this.planFilePath = PLAN_FILE_URL;
			this.enabled = true;

			this.session.setPlanModeState({
				enabled: true,
				planFilePath: this.planFilePath,
				workflow: PLAN_WORKFLOW,
			});
			this.session.setPlanProposalHandler?.((title) => this.#handlePlanProposal(title));
		} else {
			const planTools = previousTools.includes(RESOLVE_TOOL)
				? previousTools
				: [...previousTools, RESOLVE_TOOL];
			await this.session.setActiveToolsByName(planTools);

			this.previousTools = previousTools;
			this.planFilePath = PLAN_FILE_URL;
			this.enabled = true;

			this.session.setPlanModeState({
				enabled: true,
				planFilePath: this.planFilePath,
				workflow: PLAN_WORKFLOW,
			});
			this.session.setStandingResolveHandler((input) => this.#handlePlanResolve(input));
		}

		this.#broadcast({
			type: "plan_mode_changed",
			sessionId: this.sessionId,
			enabled: true,
			planFilePath: this.planFilePath,
		});
		log.info(`plan mode entered for ${this.sessionId}`);
	}

	/**
	 * Exit plan mode. Idempotent. Rejects any pending approval first so the
	 * standing handler unblocks with a clear error the agent can surface as
	 * the resolve tool's failure result.
	 *
	 * `reason` differentiates user-cancel (Shift+Tab off, Reject click) from
	 * server-side cleanup (session disposed, approve path that already did
	 * the rename + synthetic prompt).
	 */
	async exit(
		reason: "user_cancelled" | "session_disposed" | "approved" | "rejected" = "user_cancelled",
	): Promise<void> {
		if (this.disposed && reason !== "session_disposed") return;
		if (!this.enabled && !this.pendingApproval) return;

		if (this.pendingApproval) {
			const pending = this.pendingApproval;
			this.pendingApproval = undefined;
			if (reason === "user_cancelled" || reason === "session_disposed") {
				const message =
					reason === "user_cancelled"
						? bridgeT("Plan approval cancelled: user exited plan mode.")
						: bridgeT("Plan approval abandoned: session disposed.");
				pending.reject(new Error(message));
				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId: pending.proposalId,
					outcome: reason === "user_cancelled" ? "rejected" : "expired",
				});
			}
		}

		if (this.enabled) {
			if (this.previousTools.length > 0) {
				try {
					await this.session.setActiveToolsByName(this.previousTools);
				} catch (err) {
					log.warn(`tool restore failed during exit for ${this.sessionId}`, err);
				}
			}
			if (this.sdk17) {
				this.session.setPlanProposalHandler?.(null);
			} else {
				this.session.setStandingResolveHandler(null);
			}
			this.session.setPlanModeState(undefined);
			this.enabled = false;
			this.previousTools = [];

			this.#broadcast({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: false,
			});
		}

		log.info(`plan mode exited for ${this.sessionId} (${reason})`);
	}

	/**
	 * Settle the pending approval. Returns `"unknown"` when the proposalId
	 * does not match the live pending entry (already-resolved by a sibling
	 * tab; the caller surfaces a 409 + the client rolls back optimistic UI).
	 */
	respond(proposalId: string, response: PlanApprovalResponse): "settled" | "unknown" {
		const pending = this.pendingApproval;
		if (!pending || pending.proposalId !== proposalId) {
			return "unknown";
		}
		// Do NOT clear pendingApproval here — the apply callback clears it
		// after the promise resolves so any concurrent respond() racing
		// with the resolve still sees "settled" until the callback exits.
		pending.resolve(response);
		return "settled";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// Fire-and-forget — dispose is sync; the SDK call chain in exit() is
		// best-effort during teardown.
		void this.exit("session_disposed");
		this.listeners.clear();
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	#broadcast(frame: PlanModeFrame): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`plan-mode frame listener threw`, err);
			}
		}
	}

	/**
	 * Standing resolve handler. The SDK calls this when the agent submits
	 * `resolve { action: "apply" | "discard", ... }` while plan-mode is
	 * active. We use the SDK's own `runResolveInvocation` to validate the
	 * envelope (handles `action="discard"` and grammar-constrained input
	 * shapes) and shape the result as `AgentToolResult<ResolveToolDetails>`.
	 *
	 * The `apply` callback blocks on the user's `plan_response` reply.
	 * Returning from it ends the agent's resolve tool with the supplied
	 * content + details; the deferred `session.prompt(..., followUp)` then
	 * starts a fresh turn that executes the approved plan.
	 */
	#handlePlanResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetailsWire>> {
		// `runResolveInvocation` is an SDK 15-only export; SDK 17+ removed the
		// resolve tool in favor of xd:// devices, so the module is loaded
		// lazily and only reached on the SDK 15 path (platform-version-gated).
		return this.#runResolve15(input);
	}

	async #runResolve15(input: unknown): Promise<AgentToolResult<ResolveToolDetailsWire>> {
		const resolveModule = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
		const runResolve = resolveModule.runResolveInvocation;
		if (typeof runResolve !== "function") {
			throw new ToolError(bridgeT("resolve invocation is not available on this SDK build"));
		}
		return runResolve(input as Parameters<typeof runResolve>[0], {
			sourceToolName: "plan_approval",
			label: bridgeT("Plan ready for approval"),
			apply: async (_reason, extra) => {
				if (!this.enabled) {
					throw new ToolError(bridgeT("Plan mode is not active."));
				}

				const planContent = await this.#readPlanFile(this.planFilePath);
				if (planContent === null) {
					throw new ToolError(
						bridgeT("Plan file not found at {{path}}. Write the finalized plan before requesting approval.", {
							path: this.planFilePath,
						}),
					);
				}

				const normalized = resolvePlanTitle({
					suppliedTitle: extra?.title,
					planContent,
					planFilePath: this.planFilePath,
				});
				const suggestedFinalPath = `local://${normalized.fileName}`;
				const proposalId = this.#allocateProposalId();

				// Block on user approval. Stash the proposal so reconnects can
				// replay it and a parallel `set_plan_mode(false)` can reject it.
				const userResponse = await new Promise<PlanApprovalResponse>((resolve, reject) => {
					this.pendingApproval = {
						proposalId,
						planFilePath: this.planFilePath,
						planContent,
						suggestedTitle: normalized.title,
						suggestedFinalPath,
						resolve,
						reject,
					};
					this.#broadcast({
						type: "plan_proposed",
						sessionId: this.sessionId,
						proposalId,
						planFilePath: this.planFilePath,
						planContent,
						suggestedTitle: normalized.title,
						suggestedFinalPath,
					});
				});

				// Clear pending — anything after this point is post-decision.
				this.pendingApproval = undefined;

				const planFilePathAtApproval = this.planFilePath;

				if (!userResponse.approved) {
					this.#broadcast({
						type: "plan_proposal_resolved",
						sessionId: this.sessionId,
						proposalId,
						outcome: "rejected",
					});
					await this.exit("rejected");
					return {
						content: [
							{
								type: "text" as const,
								text: bridgeT("User rejected the plan. Plan mode disabled; do not auto-execute."),
							},
						],
						details: {
							planFilePath: planFilePathAtApproval,
							finalPlanFilePath: suggestedFinalPath,
							title: normalized.title,
							planExists: true,
						} satisfies PlanApprovalDetails,
					};
				}

				// Approve path: optionally write edited content, rename
				// PLAN.md → final, exit plan mode, queue the synthetic
				// approved-prompt for the next turn.
				let finalContent = planContent;
				if (typeof userResponse.editedContent === "string") {
					await this.#writePlanFile(planFilePathAtApproval, userResponse.editedContent);
					finalContent = userResponse.editedContent;
				}

				const finalPlanFilePath = sanitizeFinalPath(userResponse.finalPath) ?? suggestedFinalPath;

				// SDK 15-only export (SDK 17 never renames — the plan stays at
				// its file and `setPlanReferencePath` pins it instead).
				const { renameApprovedPlanFile } = await import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan");
				await renameApprovedPlanFile({
					planFilePath: planFilePathAtApproval,
					finalPlanFilePath,
					getArtifactsDir: this.getArtifactsDir,
					getSessionId: this.getSessionId,
				});

				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId,
					outcome: "approved",
				});

				await this.exit("approved");

				this.session.markPlanReferenceSent();
				const approvedPrompt = renderApprovedPrompt({
					planContent: finalContent,
					finalPlanFilePath,
				});

				// Fire-and-forget: the resolve tool is still streaming at
				// this point (we haven't returned yet), so the SDK queues
				// the prompt as followUp and fires it once the current
				// turn ends. The `synthetic` flag is intentionally absent
				// — the SDK's queue path doesn't preserve it; we accept
				// the resulting user-role bubble so the user sees a
				// visible "execute" handoff. v1.1 may swap to a deferred
				// turn_end listener if the synthetic distinction matters.
				void this.session
					.prompt(approvedPrompt, { streamingBehavior: "followUp" })
					.catch((err) => {
						log.warn(`synthetic approved-plan prompt failed for ${this.sessionId}`, err);
					});

				return {
					content: [
						{
							type: "text" as const,
							text: bridgeT("Plan approved. Executing from {{path}}.", {
								path: finalPlanFilePath,
							}),
						},
					],
					details: {
						planFilePath: planFilePathAtApproval,
						finalPlanFilePath,
						title: stripMdExtension(extractFileName(finalPlanFilePath)),
						planExists: true,
					} satisfies PlanApprovalDetails,
				};
			},
		});
	}

	/**
	 * SDK 17+ propose-device handler. The session dispatches the agent's
	 * `write xd://propose <title>` payload here while plan mode is active.
	 * Mirrors the resolve path's approval UI: locate the plan file, derive
	 * the title, broadcast `plan_proposed`, block on the deck's response,
	 * then either exit-rejected or pin the plan reference + queue the
	 * approved-prompt (SDK 17 never renames the plan file).
	 */
	async #handlePlanProposal(title: string): Promise<AgentToolResult<unknown>> {
		if (!this.enabled) {
			throw new ToolError(bridgeT("Plan mode is not active."));
		}
		const found = await this.#findPlanFile(title);
		if (!found) {
			throw new ToolError(
				bridgeT("Plan file not found at {{path}}. Write the finalized plan before requesting approval.", {
					path: this.planFilePath,
				}),
			);
		}
		const { planFilePath, planContent } = found;
		const normalized = resolvePlanTitle({
			suppliedTitle: title,
			planContent,
			planFilePath,
		});
		// SDK 17 semantics: the plan stays at its original file — no rename,
		// so the execution path is always the plan's own path (a user
		// finalPath override has no rename mechanism to apply it to).
		const suggestedFinalPath = planFilePath;
		const proposalId = this.#allocateProposalId();

		// Block on user approval. Stash the proposal so reconnects can replay
		// it and a parallel `set_plan_mode(false)` can reject it.
		const userResponse = await new Promise<PlanApprovalResponse>((resolve, reject) => {
			this.pendingApproval = {
				proposalId,
				planFilePath,
				planContent,
				suggestedTitle: normalized.title,
				suggestedFinalPath,
				resolve,
				reject,
			};
			this.#broadcast({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId,
				planFilePath,
				planContent,
				suggestedTitle: normalized.title,
				suggestedFinalPath,
			});
		});

		this.pendingApproval = undefined;
		// Edits + reference pin + result details must target the LOCATED plan
		// file (possibly `<slug>-plan.md`), not the state default PLAN.md —
		// otherwise a user edit is written to a file that may not exist.
		const planFilePathAtApproval = planFilePath;
		const finalPlanFilePath = suggestedFinalPath;

		if (!userResponse.approved) {
			this.#broadcast({
				type: "plan_proposal_resolved",
				sessionId: this.sessionId,
				proposalId,
				outcome: "rejected",
			});
			await this.exit("rejected");
			return {
				content: [
					{
						type: "text" as const,
						text: bridgeT("User rejected the plan. Plan mode disabled; do not auto-execute."),
					},
				],
				details: {
					planFilePath: planFilePathAtApproval,
					finalPlanFilePath,
					title: normalized.title,
					planExists: true,
				} satisfies PlanApprovalDetails,
			};
		}

		// Approve path: optionally write edited content, exit plan mode, pin
		// the plan reference, queue the synthetic approved-prompt.
		let finalContent = planContent;
		if (typeof userResponse.editedContent === "string") {
			await this.#writePlanFile(planFilePathAtApproval, userResponse.editedContent);
			finalContent = userResponse.editedContent;
		}

		this.#broadcast({
			type: "plan_proposal_resolved",
			sessionId: this.sessionId,
			proposalId,
			outcome: "approved",
		});

		await this.exit("approved");

		this.session.setPlanReferencePath?.(planFilePathAtApproval);
		this.session.markPlanReferenceSent();
		const approvedPrompt = renderApprovedPrompt({
			planContent: finalContent,
			finalPlanFilePath,
		});

		void this.session
			.prompt(approvedPrompt, { streamingBehavior: "followUp" })
			.catch((err) => {
				log.warn(`synthetic approved-plan prompt failed for ${this.sessionId}`, err);
			});

		return {
			content: [
				{
					type: "text" as const,
					text: bridgeT("Plan approved. Executing from {{path}}.", {
						path: finalPlanFilePath,
					}),
				},
			],
			details: {
				planFilePath: planFilePathAtApproval,
				finalPlanFilePath,
				title: stripMdExtension(extractFileName(finalPlanFilePath)),
				planExists: true,
			} satisfies PlanApprovalDetails,
		};
	}

	/**
	 * Locate the agent's plan file (SDK 17 semantics): title-slug candidate
	 * first (`local://<slug>-plan.md`), then scanned `*plan.md` files
	 * newest-first, then the state plan path as fallback. Returns the file
	 * with its content; null when nothing exists.
	 */
	async #findPlanFile(
		title: string,
	): Promise<{ planFilePath: string; planContent: string } | null> {
		const slugUrl = planSlugUrl(title);
		const listed = await this.#listPlanFiles();
		const candidates = [slugUrl, ...listed, this.planFilePath].filter(
			(url, idx, arr) => url && arr.indexOf(url) === idx,
		);
		for (const url of candidates) {
			if (!url) continue;
			const content = await this.#readPlanFile(url);
			if (content !== null) return { planFilePath: url, planContent: content };
		}
		return null;
	}

	/** `local://` URLs of plan files in the session-local root, newest first. */
	async #listPlanFiles(): Promise<string[]> {
		const localRoot = resolveLocalUrlToPath("local://", {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		const entries = await fs.readdir(localRoot, { withFileTypes: true });
		const candidates = entries.filter(
			(e) => e.isFile() && e.name.toLowerCase().endsWith("plan.md"),
		);
		const withMtime = await Promise.all(
			candidates.map(async (e) => {
				try {
					const st = await fs.stat(path.join(localRoot, e.name));
					return { name: e.name, mtime: st.mtimeMs };
				} catch {
					return { name: e.name, mtime: 0 };
				}
			}),
		);
		withMtime.sort((a, b) => b.mtime - a.mtime);
		return withMtime.map((f) => `local://${f.name}`);
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		try {
			return await fs.readFile(fsPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async #writePlanFile(planFilePath: string, content: string): Promise<void> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		await fs.writeFile(fsPath, content, "utf-8");
	}

	#allocateProposalId(): string {
		const id = `pa_${this.sessionId}_${this.nextProposalCounter}`;
		this.nextProposalCounter += 1;
		return id;
	}
}

function renderApprovedPrompt(args: { planContent: string; finalPlanFilePath: string }): string {
	return PLAN_APPROVED_PROMPT_TEMPLATE.replaceAll(
		"{{planContent}}",
		args.planContent,
	).replaceAll("{{finalPlanFilePath}}", args.finalPlanFilePath);
}

/**
 * Validate a client-supplied override of the final plan path. Returns
 * `undefined` when the input is missing or shaped wrong; the caller falls
 * back to the SDK-suggested path. We deliberately don't throw — a malformed
 * `finalPath` shouldn't fail the whole approval; falling back to the
 * suggested path is the user-friendly default.
 */
function sanitizeFinalPath(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const trimmed = input.trim();
	if (!trimmed.startsWith("local://")) return undefined;
	// Strip the scheme and reject anything that has path separators or `..`
	// anywhere — must be a single safe filename, NOT a nested path or
	// traversal attempt. (Stripping then taking the basename would silently
	// "sanitize" `local://../escape.md` into `escape.md`; reject instead.)
	const remainder = trimmed.replace(/^local:\/+/, "");
	if (remainder.includes("/") || remainder.includes("\\")) return undefined;
	if (remainder.includes("..")) return undefined;
	if (!remainder.endsWith(".md")) return undefined;
	const stem = remainder.slice(0, -".md".length);
	if (stem.length === 0) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(stem)) return undefined;
	return `local://${remainder}`;
}

function extractFileName(localUrl: string): string {
	return localUrl.replace(/^local:\/+/, "").split(/[\\/]/).pop() ?? "";
}

/**
 * Title → `local://<slug>-plan.md` (SDK 17's propose-device convention).
 * Mirrors the SDK's slug rules: lowercase ASCII, runs of non-alphanumerics
 * collapsed to a single hyphen, trimmed at both ends.
 */
function planSlugUrl(title: string): string | undefined {
	const slug = title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return undefined;
	return `local://${slug}-plan.md`;
}

function stripMdExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}
