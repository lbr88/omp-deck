/**
 * MultiAgentBridge — AgentBridge facade that routes sessions to the local
 * in-process bridge (`"local"` / omitted agentId) or to a remote agent host
 * (`RemoteAgentBridge`, any other agentId from the machines registry).
 *
 * Both sub-bridges keep their own session maps; `getSession` probes local
 * first, then remote. `resumeSession` is local-only (remote resume is
 * unsupported — see RemoteAgentBridge).
 */
import type { MachineRegistry } from "../machines.ts";
import { InProcessAgentBridge } from "./in-process.ts";
import { RemoteAgentBridge } from "./remote.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	ResumeSessionOpts,
	RuntimeEnvUpdate,
	SessionHandle,
} from "./types.ts";

export class MultiAgentBridge implements AgentBridge {
	private readonly local: InProcessAgentBridge;
	private readonly remote: RemoteAgentBridge;

	constructor(opts: {
		local: InProcessAgentBridge;
		machines: MachineRegistry;
	}) {
		this.local = opts.local;
		this.remote = new RemoteAgentBridge(opts.machines);
	}

	async createSession(opts: CreateSessionOpts & { agentId?: string }): Promise<SessionHandle> {
		const agentId = opts.agentId ?? "local";
		if (agentId === "local") return this.local.createSession(opts);
		return this.remote.createSession({ ...opts, agentId });
	}

	async resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle> {
		// Remote-first: a path known to a machine is resumed on that machine
		// (its SDK loads the full history into the snapshot and owns the file
		// for the session's lifetime — one writer). Paths no machine knows
		// fall through to the deck's own bridge.
		const remote = await this.remote.tryResumeSession(opts);
		if (remote) return remote;
		return this.local.resumeSession(opts);
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.local.getSession(sessionId) ?? this.remote.getSession(sessionId);
	}

	async listSessions(opts: { cwd?: string } = {}): Promise<import("@omp-deck/protocol").SessionSummary[]> {
		const [local, remote] = await Promise.all([
			this.local.listSessions(opts),
			this.remote.listSessions(opts),
		]);
		// Same-machine setups (dev, or a host sharing the deck's agent dir) can
		// surface the same session file through both bridges — dedupe by id,
		// preferring the local entry so the UI shows one row.
		const byId = new Map<string, import("@omp-deck/protocol").SessionSummary>();
		for (const s of local) byId.set(s.id, s);
		for (const s of remote) if (!byId.has(s.id)) byId.set(s.id, s);
		return [...byId.values()];
	}

	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		this.local.trackSubscriberAdded(sessionId, connectionId);
		this.remote.trackSubscriberAdded(sessionId, connectionId);
	}

	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		this.local.trackSubscriberRemoved(sessionId, connectionId);
		this.remote.trackSubscriberRemoved(sessionId, connectionId);
	}

	bumpActivity(sessionId: string): void {
		this.local.bumpActivity(sessionId);
		this.remote.bumpActivity(sessionId);
	}

	applyEnvUpdate(update: RuntimeEnvUpdate): void {
		this.local.applyEnvUpdate?.(update);
		this.remote.applyEnvUpdate(update);
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<import("@omp-deck/protocol").ModelInfo[]> {
		if (opts.sessionId) {
			// Session-scoped: route by which bridge owns the session.
			if (this.remote.getSession(opts.sessionId)) {
				return this.remote.listModels({ sessionId: opts.sessionId });
			}
			return this.local.listModels({ sessionId: opts.sessionId });
		}
		// Aggregated catalog: local models + every machine's models.
		const [local, remote] = await Promise.all([
			this.local.listModels(),
			this.remote.listModels(),
		]);
		return [...local, ...remote];
	}

	subscribeUiFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				import("@omp-deck/protocol").ServerFrame,
				{ type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }
			>,
		) => void,
	): () => void {
		if (this.local.getSession(sessionId)) {
			return this.local.subscribeUiFrames(sessionId, listener);
		}
		return this.remote.subscribeUiFrames(sessionId, listener);
	}

	respondToUiDialog(
		sessionId: string,
		dialogId: string,
		response: import("@omp-deck/protocol").ExtUiDialogResponse,
	): void {
		if (this.local.getSession(sessionId)) {
			this.local.respondToUiDialog(sessionId, dialogId, response);
			return;
		}
		this.remote.respondToUiDialog(sessionId, dialogId, response);
	}

	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				import("@omp-deck/protocol").ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }
			>,
		) => void,
	): () => void {
		if (this.local.getSession(sessionId)) {
			return this.local.subscribePlanModeFrames(sessionId, listener);
		}
		return this.remote.subscribePlanModeFrames(sessionId, listener);
	}

	async respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: import("./types.ts").PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		if (this.local.getSession(sessionId)) {
			return this.local.respondToPlanApproval(sessionId, proposalId, response);
		}
		return this.remote.respondToPlanApproval(sessionId, proposalId, response);
	}

	async dispose(): Promise<void> {
		await Promise.all([this.local.dispose(), this.remote.dispose()]);
	}

	/** Machine CRUD hooks for the /api/machines router. */
	addMachine(machine: import("../machines.ts").MachineEntry): void {
		this.remote.addMachine(machine);
	}

	removeMachine(id: string): void {
		this.remote.removeMachine(id);
	}

	machineStatus(): Array<{
		id: string;
		name: string;
		baseUrl: string;
		online: boolean;
		sessionCount: number;
		defaultCwd?: string;
	}> {
		return this.remote.machineStatus();
	}
}
