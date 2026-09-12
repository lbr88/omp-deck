/**
 * omp-agent-host — omp extension that turns a machine's omp SDK into a
 * remote agent host for an omp-deck center.
 *
 * The extension runs inside any `omp` process that loads extensions
 * (TUI sessions, `omp --mode rpc` long-running hosts, nested sessions). It
 * starts a small HTTP+WS server (Bun.serve) exposing:
 *
 *   - REST:  /host/health, /host/sessions (CRUD + abort/compact/name/model/
 *            slash-dispatch/plan-response), /host/models, /host/env
 *   - WS:    /host/ws — the deck's session protocol verbatim (HostClientFrame
 *            / HostServerFrame from @omp-deck/protocol), plus an `auth`
 *            handshake as the first frame.
 *
 * Sessions are created with the SAME shared wiring the deck's in-process
 * bridge uses (`session-core.ts`): extension runner callbacks, synthetic
 * events, shadow queue, plan-mode + extension-UI bridges. The deck-specific
 * hooks (prelude, deck slash registry, notifications) are omitted.
 *
 * Deployment: copy this file + the shared bridge files into
 * `~/.omp/agent/extensions/omp-agent-host/` (see README.md for the exact
 * layout). Runtime imports are restricted to the omp SDK, Bun builtins, and
 * the copied sibling files — no node_modules needed on the host machine.
 *
 * Security: the server binds loopback by default and requires a bearer token
 * (`OMP_AGENT_HOST_TOKEN`) on every REST call and WS handshake. Point it at
 * a tailnet interface and the token is defense-in-depth over the network.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry, SessionManager, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	ClientFrame,
	CreateSessionResponse,
	EnvEntry,
	EnvValueSource,
	HostClientFrame,
	HostServerFrame,
	ImageAttachment,
	ListSessionsResponse,
	ModelRef,
	PatchEnvSettingsRequest,
} from "@omp-deck/protocol";

import {
	createCoreSession,
	modelInfoFromSdk,
	summarizeSession,
	type CoreSessionHandle,
	type SdkModel,
} from "./bridge/session-core.ts";

/**
 * Wire shape of a slash-dispatch result — mirrors the deck's
 * `SlashDispatchResult` (bridge/types.ts) without importing deck internals.
 */
type HostSlashDispatchResult =
	| { kind: "fallthrough" }
	| { kind: "consumed"; output: string }
	| { kind: "rewritten"; output: string; prompt: string };

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
	port: Number.parseInt(process.env.OMP_AGENT_HOST_PORT ?? "8790", 10),
	bind: process.env.OMP_AGENT_HOST_BIND ?? "127.0.0.1",
	token: process.env.OMP_AGENT_HOST_TOKEN ?? "",
	agentDir: process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"),
	idleTimeoutMs: Number.parseInt(process.env.OMP_AGENT_HOST_IDLE_TIMEOUT_MS ?? String(15 * 60_000), 10),
} as const;

/** Env file the center can edit through /host/env. */
const HOST_ENV_PATH = path.join(os.homedir(), ".config", "omp-agent-host", "host.env");

/** Load managed host.env values into process.env without overriding the shell. */
function applyHostEnvFileToProcess(): void {
	const file = readHostEnvFile();
	for (const [key, value] of file.values) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
	if (file.values.size > 0) {
		// eslint-disable-next-line no-console
		console.log(`[omp-agent-host] loaded ${file.values.size} managed env var(s) from host.env`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton guard — nested sessions re-discover + re-load this extension, and
// each load would otherwise start a second server. The flag survives across
// loads because it lives on globalThis.
// ─────────────────────────────────────────────────────────────────────────────

const SERVED_FLAG = "__omp_agent_host_served__";

export default function ompAgentHost(_pi: ExtensionAPI): void {
	if (SERVED_FLAG in globalThis) {
		return; // nested session re-load — server already running
	}
	startHost();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────────────────────────────────────

interface HostSession {
	handle: CoreSessionHandle;
	/** SDK event subscription teardown. */
	unsubscribe: () => void;
	/** WS connections currently subscribed to this session. */
	subscribers: Set<ServerWebSocket<HostSocketData>>;
	/** Auto-start prompt queued until the first subscriber attaches. */
	pendingAutoPrompt: string | null;
	lastActivityAt: number;
	turnInFlight: boolean;
}

interface HostSocketData {
	authed: boolean;
}

const sessions = new Map<string, HostSession>();
let hostEnvWriteCounter = 0;
let modelRegistryPromise: Promise<ModelRegistry> | undefined;
let reaperTimer: ReturnType<typeof setInterval> | null = null;
let server: Server<HostSocketData> | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

function startHost(): void {
	if (!CONFIG.token) {
		// eslint-disable-next-line no-console
		console.warn(
			`[omp-agent-host] OMP_AGENT_HOST_TOKEN is not set — server NOT started. ` +
				`Set it (e.g. \`openssl rand -hex 32\`) and restart omp.`,
		);
		return;
	}

	// Persist managed env across restarts: PATCH /host/env writes host.env and
	// hot-applies values; re-load them here so API keys / OMP_MODEL / LOG_LEVEL
	// survive an omp restart. Launching-shell values keep priority (we never
	// override), mirroring the deck's loadManagedEnvIntoProcess.
	applyHostEnvFileToProcess();

	try {
		server = Bun.serve<HostSocketData>({
			port: CONFIG.port,
			hostname: CONFIG.bind,
			fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/host/ws") {
					const upgraded = srv.upgrade(req, { data: { authed: false } });
					if (upgraded) return undefined;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return handleRest(req, url);
			},
				websocket: {
					open(ws) {
						// The first frame MUST be `auth`; unauthenticated connections get
						// closed on their first non-auth message.
						ws.data.authed = false;
					},
					message(ws, raw) {
						void handleWsMessage(ws, raw);
					},
					close(ws) {
						dropConnection(ws);
					},
				},
			});
		} catch (err) {
			// EADDRINUSE etc. — another omp process is already serving this host.
			// Log and leave the singleton guard unset so a later load in this
			// process can still start the server once the port frees up.
			// eslint-disable-next-line no-console
			console.warn(
				`[omp-agent-host] failed to bind ${CONFIG.bind}:${CONFIG.port} — another omp process likely serves it: ${String(err)}`,
			);
			return;
		}
	// Arm the singleton guard ONLY after the server actually serves, so a
	// failed bind does not permanently disable the host in this process.
	Object.defineProperty(globalThis, SERVED_FLAG, { value: true, configurable: false, enumerable: false });
	// eslint-disable-next-line no-console
	console.log(
		`[omp-agent-host] serving on http://${CONFIG.bind}:${CONFIG.port} (agentDir=${CONFIG.agentDir})`,
	);

	if (CONFIG.idleTimeoutMs > 0) {
		reaperTimer = setInterval(() => {
			void reapIdle();
		}, 60_000);
		(reaperTimer as unknown as { unref?: () => void }).unref?.();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// REST
// ─────────────────────────────────────────────────────────────────────────────

/** Constant-time bearer-token comparison (the token is the only auth boundary). */
function tokenMatches(provided: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(CONFIG.token);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function authed(req: Request): boolean {
	const header = req.headers.get("authorization");
	if (!header || !header.startsWith("Bearer ")) return false;
	return tokenMatches(header.slice("Bearer ".length));
}

function unauthorized(): Response {
	return Response.json({ error: "unauthorized" }, { status: 401 });
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (!text.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		// JSON-object boundary: validated shape above, narrowed to a plain
		// record for field reads below.
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

async function handleRest(req: Request, url: URL): Promise<Response> {
	// Health is unauthenticated so the center can probe liveness without
	// rotating tokens; everything else requires the bearer token.
	if (req.method === "GET" && url.pathname === "/host/health") {
		return json({ ok: true, pid: process.pid, hostname: os.hostname(), port: CONFIG.port, uptimeSecs: process.uptime() });
	}
	if (!authed(req)) return unauthorized();

	try {
		if (url.pathname === "/host/sessions") {
			if (req.method === "POST") return await createSessionHandler(req);
			if (req.method === "GET") return await listSessionsHandler();
			return json({ error: "method not allowed" }, 405);
		}
		if (req.method === "DELETE" && url.pathname.startsWith("/host/sessions/")) {
			return await deleteSessionHandler(decodeURIComponent(url.pathname.slice("/host/sessions/".length)));
		}
		if (req.method === "POST" && url.pathname.startsWith("/host/sessions/")) {
			const rest = url.pathname.slice("/host/sessions/".length);
			const slashIdx = rest.indexOf("/");
			if (slashIdx === -1) return json({ error: "unknown endpoint" }, 404);
			const sessionId = decodeURIComponent(rest.slice(0, slashIdx));
			const op = rest.slice(slashIdx + 1);
			if (op === "abort") return await sessionOpHandler(sessionId, (s) => s.handle.abort());
			if (op === "compact") return await compactHandler(sessionId, req);
			if (op === "name") return await setNameHandler(sessionId, req);
			if (op === "model") return await setModelHandler(sessionId, req);
			if (op === "slash-dispatch") return await slashDispatchHandler(sessionId, req);
			if (op === "plan-response") return await planResponseHandler(sessionId, req);
			return json({ error: "unknown endpoint" }, 404);
		}
		if (url.pathname === "/host/models" && req.method === "GET") return await modelsHandler();
		if (url.pathname === "/host/env" && req.method === "GET") return envHandler();
		if (url.pathname === "/host/env" && req.method === "PATCH") return await patchEnvHandler(req);
		return json({ error: "not found" }, 404);
	} catch (err) {
		return json({ error: String(err instanceof Error ? err.message : err) }, 500);
	}
}

async function createSessionHandler(req: Request): Promise<Response> {
	const raw = await readJson(req);
	const model = pickModelRef(raw.model);
	const entry =
		typeof raw.resumeFromPath === "string" && raw.resumeFromPath.trim()
			? await resumeHostSession(raw.resumeFromPath.trim(), model)
			: await createHostSession({
					cwd:
						typeof raw.cwd === "string" && raw.cwd.trim()
							? raw.cwd.trim()
							: process.env.OMP_AGENT_HOST_DEFAULT_CWD ?? os.homedir(),
					...(model ? { model } : {}),
					suppressAutoStart: raw.suppressAutoStart === true,
				});
	const resp: CreateSessionResponse = { sessionId: entry.handle.sessionId, cwd: entry.handle.cwd };
	return json(resp, 201);
}

/**
 * Resume a persisted session file (the machine's own disk path) as a live
 * SDK session — the remote equivalent of the deck's local resumeSession.
 * The center's sidebar passes the session `path` from GET /host/sessions.
 */
async function resumeHostSession(resumeFromPath: string, model?: ModelRef): Promise<HostSession> {
	const sessionManager = await SessionManager.open(resumeFromPath);
	const cwd = (sessionManager.getCwd?.() as string | undefined) ?? process.env.OMP_AGENT_HOST_DEFAULT_CWD ?? os.homedir();
	const modelRegistry = await ensureModelRegistry();
	const { handle, unsubscribe } = await createCoreSession({
		cwd,
		sessionManager,
		modelRegistry,
		...(model ? { model } : {}),
		hasUI: true,
		skipPythonPreflight: true,
	});
	return registerHostSession(handle, unsubscribe, null, `resumed from ${resumeFromPath}`);
}

/** Narrow a raw `model` body field ({provider,id} strings) with runtime checks. */
function pickModelRef(value: unknown): ModelRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (!("provider" in value) || !("id" in value)) return undefined;
	const provider = value.provider;
	const id = value.id;
	if (typeof provider !== "string" || typeof id !== "string" || !provider || !id) return undefined;
	return { provider, id };
}

async function listSessionsHandler(): Promise<Response> {
	const raw = await SessionManager.listAll();
	const sessions = raw.map((r) => {
		// SDK 17 names session files `<timestamp>_<agentId>.jsonl`; the record's
		// own `id` can drift from the wire session id (e.g. when two SDK
		// versions share an agent dir), so prefer the filename-derived id —
		// the center routes sessions by the ids it got from POST /host/sessions.
		const summary = summarizeSession(r, "remote");
		const fileId = agentIdFromSessionPath(summary.path);
		return fileId && fileId !== summary.id ? { ...summary, id: fileId } : summary;
	});
	const body: ListSessionsResponse = { sessions };
	return json(body);
}

/** Extract the trailing UUID from a session file basename, if present. */
function agentIdFromSessionPath(filePath: string): string | undefined {
	const base = filePath.split(/[\\/]/).pop() ?? "";
	const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
	return m ? m[1] : undefined;
}

async function deleteSessionHandler(sessionId: string): Promise<Response> {
	const entry = sessions.get(sessionId);
	if (!entry) return json({ error: "session not found" }, 404);
	await disposeSession(entry);
	return json({ ok: true });
}

async function sessionOpHandler(sessionId: string, op: (s: HostSession) => Promise<void>): Promise<Response> {
	const entry = sessions.get(sessionId);
	if (!entry) return json({ error: "session not found" }, 404);
	entry.lastActivityAt = Date.now();
	await op(entry);
	return json({ ok: true });
}

async function compactHandler(sessionId: string, req: Request): Promise<Response> {
	const raw = await readJson(req);
	const focus = typeof raw.focus === "string" && raw.focus.trim() ? raw.focus.trim() : undefined;
	return sessionOpHandler(sessionId, (s) => s.handle.compact(focus));
}

async function setNameHandler(sessionId: string, req: Request): Promise<Response> {
	const raw = await readJson(req);
	if (typeof raw.name !== "string") return json({ error: "name is required" }, 400);
	const name = raw.name.trim();
	return sessionOpHandler(sessionId, (s) => s.handle.setName(name));
}

async function setModelHandler(sessionId: string, req: Request): Promise<Response> {
	const raw = await readJson(req);
	const provider = typeof raw.provider === "string" ? raw.provider : "";
	const id = typeof raw.id === "string" ? raw.id : "";
	if (!provider || !id) return json({ error: "provider and id strings required" }, 400);
	return sessionOpHandler(sessionId, (s) => s.handle.setModel({ provider, id }));
}

async function slashDispatchHandler(sessionId: string, req: Request): Promise<Response> {
	const raw = await readJson(req);
	if (typeof raw.text !== "string") return json({ error: "text is required" }, 400);
	const entry = sessions.get(sessionId);
	if (!entry) return json({ error: "session not found" }, 404);
	entry.lastActivityAt = Date.now();
	const result: HostSlashDispatchResult = await entry.handle.dispatchSlashCommand(raw.text);
	return json(result);
}

async function planResponseHandler(sessionId: string, req: Request): Promise<Response> {
	const raw = await readJson(req);
	const proposalId = typeof raw.proposalId === "string" ? raw.proposalId : "";
	if (!proposalId) return json({ error: "proposalId is required" }, 400);
	const entry = sessions.get(sessionId);
	if (!entry) return json({ error: "session not found" }, 404);
	entry.lastActivityAt = Date.now();
	const outcome = await entry.handle.respondToPlanApproval(proposalId, {
		approved: raw.approved === true,
		...(typeof raw.finalPath === "string" ? { finalPath: raw.finalPath } : {}),
		...(typeof raw.editedContent === "string" ? { editedContent: raw.editedContent } : {}),
	});
	return json({ outcome });
}

async function modelsHandler(): Promise<Response> {
	const registry = await ensureModelRegistry();
	const models = registry.getAll().map((model) => modelInfoFromSdk(model as unknown as SdkModel, registry, undefined));
	return json({ models });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

function ensureModelRegistry(): Promise<ModelRegistry> {
	if (modelRegistryPromise) return modelRegistryPromise;
	modelRegistryPromise = (async () => {
		const auth = await discoverAuthStorage(CONFIG.agentDir);
		const registry = new ModelRegistry(auth);
		await registry.refresh("offline");
		registry.refreshInBackground("online");
		return registry;
	})();
	return modelRegistryPromise;
}

async function createHostSession(opts: { cwd: string; model?: ModelRef; suppressAutoStart?: boolean }): Promise<HostSession> {
	const sessionManager = SessionManager.create(opts.cwd);
	const modelRegistry = await ensureModelRegistry();
	const { handle, unsubscribe } = await createCoreSession({
		cwd: opts.cwd,
		sessionManager,
		modelRegistry,
		...(opts.model ? { model: opts.model } : {}),
		hasUI: true,
		skipPythonPreflight: true,
	});

	return registerHostSession(handle, unsubscribe, opts.suppressAutoStart ? null : "/start", `cwd=${opts.cwd}`);
}

/**
 * Register a freshly-created SDK session in the host's session map and wire
 * its event fan-out + dispose lifecycle. Shared by create and resume paths.
 */
function registerHostSession(
	handle: CoreSessionHandle,
	unsubscribe: () => void,
	pendingAutoPrompt: string | null,
	label: string,
): HostSession {
	const entry: HostSession = {
		handle,
		unsubscribe,
		subscribers: new Set(),
		pendingAutoPrompt,
		lastActivityAt: Date.now(),
		turnInFlight: false,
	};
	sessions.set(handle.sessionId, entry);

	// Bridge SDK events → every subscribed connection. Mirrors the deck's
	// ws.ts fan-out: session events + synthetic events flow through the
	// handle's listeners; extension-UI and plan-mode frames ride their own
	// bridges. The reaper's turn-in-flight tracking piggybacks the same tap.
	const unsubEvents = handle.subscribe((event) => {
		const type = event.type;
		entry.lastActivityAt = Date.now();
		if (type === "turn_start") entry.turnInFlight = true;
		else if (type === "turn_end" || type === "agent_end") entry.turnInFlight = false;
		const frame: HostServerFrame = { type: "session_event", sessionId: handle.sessionId, event };
		sendToSubscribers(entry, frame);
	});
	const unsubUi = handle.uiBridge.subscribeFrames((frame) => sendToSubscribers(entry, frame));
	const unsubPlan = handle.planBridge.subscribeFrames((frame) => sendToSubscribers(entry, frame));
	const originalDispose = handle.dispose.bind(handle);
	entry.unsubscribe = () => {
		unsubEvents();
		unsubUi();
		unsubPlan();
		unsubscribe();
	};

	// Keep the SDK session's dispose hooked so explicit disposes (and the
	// deck's DELETE) notify subscribers + drop the map entry.
	(handle as unknown as { dispose: () => Promise<void> }).dispose = async () => {
		await originalDispose();
		sessions.delete(handle.sessionId);
		sendToSubscribers(entry, { type: "session_disposed", sessionId: handle.sessionId });
		entry.subscribers.clear();
		entry.unsubscribe();
	};

	// eslint-disable-next-line no-console
	console.log(`[omp-agent-host] session ${handle.sessionId} ${label}`);
	return entry;
}

function sendToSubscribers(entry: HostSession, frame: HostServerFrame): void {
	const payload = JSON.stringify(frame);
	for (const ws of entry.subscribers) {
		try {
			// -1 = dropped (bufferedAmount over the limit) — the deck can only
			// recover via resubscribe, so drop the slow connection and let its
			// HostClient auto-reconnect + re-subscribe (snapshot resync).
			if (ws.send(payload) === -1) {
				// eslint-disable-next-line no-console
				console.warn(`[omp-agent-host] subscriber send dropped; closing slow connection`);
				ws.close();
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn(`[omp-agent-host] subscriber send failed`, err);
		}
	}
}

async function disposeSession(entry: HostSession): Promise<void> {
	await entry.handle.dispose();
}

async function reapIdle(): Promise<void> {
	const now = Date.now();
	const cutoff = now - CONFIG.idleTimeoutMs;
	const candidates: HostSession[] = [];
	for (const entry of sessions.values()) {
		if (entry.turnInFlight) continue;
		if (entry.subscribers.size > 0) continue;
		if (entry.lastActivityAt > cutoff) continue;
		candidates.push(entry);
	}
	for (const entry of candidates) {
		// eslint-disable-next-line no-console
		console.log(`[omp-agent-host] reaping idle session ${entry.handle.sessionId}`);
		await disposeSession(entry).catch((err) => {
			// eslint-disable-next-line no-console
			console.warn(`[omp-agent-host] reap dispose failed`, err);
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket (deck link)
// ─────────────────────────────────────────────────────────────────────────────

async function handleWsMessage(ws: ServerWebSocket<HostSocketData>, raw: string | Buffer): Promise<void> {
	let frame: HostClientFrame;
	try {
		frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as HostClientFrame;
	} catch {
		ws.send(JSON.stringify({ type: "host_error", message: "invalid json" } satisfies HostServerFrame));
		ws.close();
		return;
	}

	if (!ws.data.authed) {
		if (frame.type === "auth" && tokenMatches(frame.token)) {
			ws.data.authed = true;
			ws.send(JSON.stringify({ type: "host_ready", machineId: os.hostname() } satisfies HostServerFrame));
		} else {
			ws.send(JSON.stringify({ type: "host_error", message: "unauthorized" } satisfies HostServerFrame));
			ws.close();
		}
		return;
	}
	if (frame.type === "auth") return; // re-auth after handshake — ignore

	await handleClientFrame(ws, frame);
}

async function handleClientFrame(ws: ServerWebSocket<HostSocketData>, frame: ClientFrame): Promise<void> {
	switch (frame.type) {
		case "ping":
			ws.send(JSON.stringify({ type: "pong" } satisfies HostServerFrame));
			return;
		case "subscribe":
			handleSubscribe(ws, frame.sessionId);
			return;
		case "unsubscribe":
			handleUnsubscribe(ws, frame.sessionId);
			return;
		case "prompt": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			const opts: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] } = {};
			if (frame.streamingBehavior) opts.streamingBehavior = frame.streamingBehavior;
			if (frame.images && frame.images.length > 0) opts.images = frame.images;
			try {
				await entry.handle.prompt(frame.text, opts);
			} catch (err) {
				sendSessionError(ws, frame.sessionId, `prompt failed: ${String(err)}`);
			}
			return;
		}
		case "abort": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			try {
				await entry.handle.abort();
			} catch (err) {
				sendSessionError(ws, frame.sessionId, `abort failed: ${String(err)}`);
			}
			return;
		}
		case "clear_queue": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			entry.handle.clearQueue();
			return;
		}
		case "cancel_queued": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			await entry.handle.cancelQueuedById(frame.queuedId);
			return;
		}
		case "edit_queued": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			await entry.handle.editQueuedById(frame.queuedId, frame.text, frame.images);
			return;
		}
		case "ext_ui_dialog_response": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			const { type: _t, sessionId: _sid, dialogId, ...response } = frame;
			void _t;
			void _sid;
			entry.handle.uiBridge.handleResponse(dialogId, response);
			return;
		}
		case "set_plan_mode": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			try {
				await entry.handle.setPlanMode(frame.enabled);
			} catch (err) {
				sendSessionError(ws, frame.sessionId, `set_plan_mode failed: ${String(err)}`);
			}
			return;
		}
		case "plan_response": {
			const entry = sessions.get(frame.sessionId);
			if (!entry) return sendSessionError(ws, frame.sessionId, "session not active");
			entry.lastActivityAt = Date.now();
			try {
				const outcome = await entry.handle.respondToPlanApproval(frame.proposalId, {
					approved: frame.approved,
					...(frame.finalPath !== undefined ? { finalPath: frame.finalPath } : {}),
					...(frame.editedContent !== undefined ? { editedContent: frame.editedContent } : {}),
				});
				if (outcome === "unknown") {
					sendSessionError(ws, frame.sessionId, `plan_response: proposal ${frame.proposalId} already resolved or unknown`);
				}
			} catch (err) {
				sendSessionError(ws, frame.sessionId, `plan_response failed: ${String(err)}`);
			}
			return;
		}
		default:
			ws.send(JSON.stringify({ type: "host_error", message: "unknown frame type" } satisfies HostServerFrame));
	}
}

function handleSubscribe(ws: ServerWebSocket<HostSocketData>, sessionId: string): void {
	const entry = sessions.get(sessionId);
	if (!entry) {
		sendSessionError(ws, sessionId, "session not active");
		return;
	}
	const wasEmpty = entry.subscribers.size === 0;
	entry.subscribers.add(ws);
	entry.lastActivityAt = Date.now();

	// First subscriber — flush any queued auto-prompt, deferred one macrotask
	// so the snapshot frame lands before agent events start flowing.
	if (wasEmpty) {
		const pending = entry.pendingAutoPrompt;
		if (pending !== null) {
			entry.pendingAutoPrompt = null;
			setTimeout(() => {
				entry.handle.prompt(pending).catch((err) => {
					// eslint-disable-next-line no-console
					console.warn(`[omp-agent-host] auto-start prompt failed for ${sessionId}`, err);
				});
			}, 50);
		}
	}
	// Authoritative snapshot for the subscribing connection. The center caches
	// it and forwards it to its web client.
	ws.send(JSON.stringify({ type: "subscribed", sessionId, snapshot: entry.handle.snapshot() } satisfies HostServerFrame));
	// Replay pending extension-UI dialogs + plan-mode state to the new
	// subscriber so a page reload mid-dialog / mid-approval re-renders the
	// modal and the plan pill + approval card (mirrors the deck's
	// subscribeUiFrames/subscribePlanModeFrames replay behavior).
	for (const frame of entry.handle.uiBridge.getPendingFrames()) {
		ws.send(JSON.stringify(frame));
	}
	for (const frame of entry.handle.planBridge.getReplayFrames()) {
		ws.send(JSON.stringify(frame));
	}
}

function handleUnsubscribe(ws: ServerWebSocket<HostSocketData>, sessionId: string): void {
	const entry = sessions.get(sessionId);
	if (!entry) return;
	entry.subscribers.delete(ws);
	entry.lastActivityAt = Date.now();
}

function dropConnection(ws: ServerWebSocket<HostSocketData>): void {
	for (const entry of sessions.values()) {
		entry.subscribers.delete(ws);
	}
}

function sendSessionError(ws: ServerWebSocket<HostSocketData>, sessionId: string, message: string): void {
	ws.send(JSON.stringify({ type: "error", sessionId, error: message } satisfies HostServerFrame));
}

// ─────────────────────────────────────────────────────────────────────────────
// Env management (trimmed env-schema; see apps/server/src/env-schema.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface HostEnvEntry extends EnvEntry {}

const HOST_ENV_SCHEMA: ReadonlyArray<{
	key: string;
	defaultValue?: string;
	valueType: "string" | "int" | "path" | "enum" | "boolean";
	sensitive: boolean;
	description: string;
	options?: string[];
}> = [
	{ key: "OMP_AGENT_DIR", valueType: "path", sensitive: false, description: "omp SDK session/auth data directory." },
	{ key: "LOG_LEVEL", defaultValue: "info", valueType: "enum", options: ["debug", "info", "warn", "error"], sensitive: false, description: "Host log threshold." },
	{ key: "PI_NO_TITLE", valueType: "boolean", sensitive: false, description: "Disable SDK automatic title generation when set truthy." },
	{ key: "OMP_MODEL", valueType: "string", sensitive: false, description: "Default omp SDK model identifier." },
	...(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"] as const).map(
		(key) => ({
			key,
			valueType: "string" as const,
			sensitive: true,
			description: "Provider API key used by the omp SDK. Replace only; never revealed in list responses.",
		}),
	),
];

const HOST_ENV_BY_KEY = new Map(HOST_ENV_SCHEMA.map((entry) => [entry.key, entry]));

interface HostEnvFile {
	values: Map<string, string>;
}

function readHostEnvFile(): HostEnvFile {
	const values = new Map<string, string>();
	if (!fs.existsSync(HOST_ENV_PATH)) return { values };
	const text = fs.readFileSync(HOST_ENV_PATH, "utf8");
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		// quoteEnvValue writes JSON.stringify escapes for unsafe values; undo
		// them on read (JSON.parse of the quoted form), falling back to the
		// raw slice for hand-edited files.
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				value = value.slice(1, -1);
			}
		} else if (value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		}
		if (key) values.set(key, value);
	}
	return { values };
}

function writeHostEnvFile(updates: Record<string, string | null>): void {
	const file = readHostEnvFile();
	for (const [key, value] of Object.entries(updates)) {
		if (value === null) file.values.delete(key);
		else file.values.set(key, value);
	}
	fs.mkdirSync(path.dirname(HOST_ENV_PATH), { recursive: true });
	const lines = Array.from(file.values.entries())
		.map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
		.sort();
	const content = ["# omp-agent-host managed environment — edited via the center deck", ...lines, ""].join("\n");
	// Unique tmp per call so overlapping PATCHes can't truncate each other's
	// file; fsync before rename so a crash can't lose the update.
	const tmp = `${HOST_ENV_PATH}.tmp-${process.pid}-${(hostEnvWriteCounter++).toString(36)}`;
	fs.writeFileSync(tmp, content);
	try {
		const fd = fs.openSync(tmp, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// fsync unsupported (some tmpfs) — best effort
	}
	fs.renameSync(tmp, HOST_ENV_PATH);
}

function quoteEnvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function resolveEnvEntry(schema: { key: string; defaultValue?: string; sensitive: boolean }): {
	source: EnvValueSource;
	value?: string;
} {
	const fileValue = readHostEnvFile().values.get(schema.key);
	const processValue = process.env[schema.key];
	if (processValue !== undefined) return { source: "process-env", value: processValue };
	if (fileValue !== undefined) return { source: "env-file", value: fileValue };
	if (schema.defaultValue !== undefined) return { source: "default", value: schema.defaultValue };
	return { source: "unset" };
}

function maskValue(value: string | undefined, sensitive: boolean): string {
	if (!value) return "unset";
	if (!sensitive) return value;
	const tail = value.slice(-4);
	return tail ? `••••••••${tail}` : "••••••••";
}

function envHandler(): Response {
	const entries: HostEnvEntry[] = HOST_ENV_SCHEMA.map((schema) => {
		const current = resolveEnvEntry(schema);
		const entry: HostEnvEntry = {
			key: schema.key,
			masked: maskValue(current.value, schema.sensitive),
			isSet: current.value !== undefined && current.value !== "",
			source: current.source,
			valueType: schema.valueType,
			sensitive: schema.sensitive,
			restartRequired: false,
			hotApply: true,
			description: schema.description,
		};
		if (schema.defaultValue !== undefined) entry.defaultValue = schema.defaultValue;
		if (schema.options) entry.options = [...schema.options];
		return entry;
	});
	return json({ entries, envFilePath: HOST_ENV_PATH, dataDir: path.dirname(HOST_ENV_PATH), restartRequired: false });
}

async function patchEnvHandler(req: Request): Promise<Response> {
	let body: PatchEnvSettingsRequest;
	try {
		const parsed: unknown = await req.json();
		body = parsed as PatchEnvSettingsRequest;
	} catch {
		return json({ error: "invalid json body" }, 400);
	}
	const updates = body.updates ?? {};
	const clean: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(updates)) {
		const schema = HOST_ENV_BY_KEY.get(key);
		if (!schema) return json({ error: `unknown env key: ${key}` }, 400);
		if (value !== null && typeof value !== "string") return json({ error: `invalid env value for ${key}` }, 400);
		clean[key] = value;
	}
	writeHostEnvFile(clean);
	// Hot-apply to process.env (like the deck's applyManagedEnvUpdatesToProcess).
	for (const [key, value] of Object.entries(clean)) {
		if (value === null) delete process.env[key];
		else process.env[key] = value;
	}
	// eslint-disable-next-line no-console
	console.log(`[omp-agent-host] env updated: ${Object.keys(clean).join(", ")}`);
	return envHandler();
}
