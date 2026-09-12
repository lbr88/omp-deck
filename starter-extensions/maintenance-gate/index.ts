/**
 * maintenance-gate
 *
 * Nudges the agent at turn-end to capture session output into the canonical
 * OMP folders before the conversation moves on. Synthesizes a follow-up
 * user message with a structured "Maintenance check" prompt; the agent
 * either writes into a capture path or states the literal phrase
 * "No maintenance needed" to release the check.
 *
 * Design (rewritten 2026-05-21 after "fires too often" feedback):
 *
 *   The gate fires AT MOST ONCE per "release segment". A release segment
 *   begins at session start (or right after the most recent release event)
 *   and ends at the next release event. A release event is:
 *
 *     - the agent writes into a capture path (inbox/, tasks/, knowledge/,
 *       queries/, context/, reminders/, or a SKILL.md file), OR
 *     - the agent emits the literal phrase "No maintenance needed".
 *
 *   Both kinds of release advance a `releaseCursor` (a tuple of branch
 *   length + wall-clock time). Once the gate fires, it records its own
 *   `lastFireBranchLength`; the gate is "spent" for the current segment
 *   until the cursor advances past that point.
 *
 *   In addition to the once-per-segment invariant, the gate enforces three
 *   floors so it doesn't fire on trivial activity right after a release:
 *
 *     - ≥ MIN_OP_MSGS_SINCE_RELEASE   operator messages since the cursor
 *     - ≥ MIN_TIME_SINCE_RELEASE_MS   wall-clock since the cursor
 *     - ≥ MIN_TIME_BETWEEN_FIRES_MS   wall-clock since the last fire
 *
 *   The first two are per-session; the last is persisted on disk so
 *   restart-rapid sessions don't get re-nailed.
 *
 *   Compared to the previous 7-layer heuristic stack this collapses the
 *   suppression model to one durable cursor + three thresholds, which
 *   produces dramatically calmer behavior in long agentic sessions while
 *   still firing at meaningful "yield" points.
 *
 * Tuning knobs are env-overridable AND read on every evaluation, so the deck
 * Settings → Orientation panel can change them live without restarting any
 * agent session:
 *
 *   OMP_MAINTENANCE_GATE_MIN_OP_MSGS         (default 4)
 *   OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS  (default 8 * 60_000)
 *   OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS       (default 25 * 60_000)
 *   OMP_MAINTENANCE_GATE_ROOTS               (CSV of explicit org roots)
 *   OMP_DECK_ORG_ROOT                        (deck-session org root; set by
 *                                             the deck server before spawning
 *                                             sessions so the gate activates
 *                                             regardless of session cwd)
 *   OMP_DECK_MAINTENANCE_GATE_DISABLED       (truthy => gate stays silent;
 *                                             checked at session_start AND
 *                                             every turn_end so a mid-session
 *                                             toggle takes effect immediately)
 *
 * Installed by omp-deck's StarterExtensionsInstaller into
 * `~/.omp/agent/extensions/maintenance-gate/`. Idempotent — never
 * overwrites a user-edited copy.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Marker phrase the agent uses to release the gate. Case-sensitive so casual
// prose mentioning "no maintenance needed" doesn't suppress accidentally.
const NO_MAINT_PHRASE = "No maintenance needed";

// Heading text the reminder uses. Doubles as a branch-walk marker for
// detecting "have we already fired in this segment".
const FIRE_MARKER = "## Maintenance check";

// Tuning floors are read per-fire, not at module init, so the deck Settings
// → Orientation panel can hot-apply changes without requiring the user to
// reload every session. The `OMP_DECK_MAINTENANCE_GATE_DISABLED` flag bails
// the gate at activation time and again on every turn_end as a safety net.
function getMinOpMsgsSinceRelease(): number {
	return envInt("OMP_MAINTENANCE_GATE_MIN_OP_MSGS", 4);
}
function getMinTimeSinceReleaseMs(): number {
	return envInt("OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS", 8 * 60 * 1000);
}
function getMinTimeBetweenFiresMs(): number {
	return envInt("OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS", 25 * 60 * 1000);
}
function isGateDisabled(): boolean {
	const raw = (process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED ?? "").trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(raw);
}

// Capture path detection. First-folder segment match against the canonical
// OMP folders, plus `kb` for deck-managed wiki writes. Anchored on
// start-of-string OR a separator so relative paths like `tasks/foo.md`
// match the same as `C:/.../tasks/foo.md`.
const CAPTURE_PATH_RE =
	/(?:^|[\/\\])(inbox|tasks|knowledge|queries|context|reminders|kb)[\/\\]/i;

// Skill creation also counts as maintenance. User-level
// (~/.omp/agent/skills) and project-level (<cwd>/.omp/skills) both match.
const SKILL_PATH_RE =
	/[\/\\]\.omp[\/\\](?:agent[\/\\])?skills[\/\\][^\/\\]+[\/\\]SKILL\.md$/i;

// Deck-style captures via REST. The agent invokes these as bash curl calls
// or eval/fetch calls — POST /api/inbox, POST/PATCH /api/tasks, POST/PUT
// /api/kb/file. Two independent assertions because curl puts the verb BEFORE
// the path (`curl -X POST .../api/inbox`) while fetch puts it AFTER
// (`fetch('.../api/inbox', { method: 'POST', ... })`).
const DECK_CAPTURE_PATH_RE = /\/api\/(?:inbox|tasks|kb\/file)\b/i;
const DECK_CAPTURE_VERB_RE = /\b(POST|PUT|PATCH)\b/i;

type Profile = "active" | "inactive";

/** In-memory state for a single session. */
interface GateState {
	/** Branch index of the most recent release event. -1 until set. */
	releaseCursorBranchLength: number;
	/** Wall clock of the most recent release event. */
	releaseCursorTimeMs: number;
	/** Branch index of the most recent fire. -1 = never fired in this session. */
	lastFireBranchLength: number;
	/** Re-entry guard so the turn_end that fires right after our own
	 *  sendUserMessage doesn't recursively re-evaluate. */
	firingNow: boolean;
}

/** Disk-persisted state for cross-session throttling. */
interface GateDiskState {
	lastFireMs: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
	const raw = process.env[name];
	if (!raw) return def;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Structural sniff for an OMP org root. Returns the absolute path when the
 * cwd looks like an org tree (or an ancestor does), else null. Requires
 * inbox/ + tasks/ AND at least one of (knowledge/, context/). Walks up the
 * directory tree until the filesystem root, so nested sessions still detect
 * the right org root. `OMP_MAINTENANCE_GATE_ROOTS` (CSV of absolute paths)
 * overrides the structural sniff.
 */
function detectOrgRoot(cwd: string): string | null {
	// Hard kill switch from the deck Settings → Orientation panel. Bails the
	// gate regardless of which other signal (deck root, explicit roots,
	// structural sniff) would otherwise activate it.
	if (isGateDisabled()) return null;

	// Highest priority: deck-session marker. The deck server sets this for
	// every session it spawns so the gate activates regardless of cwd, which
	// for deck sessions rarely matches the flat-file org structure below.
	const deckRoot = process.env.OMP_DECK_ORG_ROOT?.trim();
	if (deckRoot && deckRoot.length > 0) return deckRoot;

	const explicit = (process.env.OMP_MAINTENANCE_GATE_ROOTS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const root of explicit) {
		const normalized = root.replace(/\\/g, "/");
		const cwdNorm = cwd.replace(/\\/g, "/");
		if (cwdNorm === normalized || cwdNorm.startsWith(`${normalized}/`)) return root;
	}

	let cursor = cwd;
	let prev = "";
	while (cursor && cursor !== prev) {
		if (
			existsSync(join(cursor, "inbox")) &&
			existsSync(join(cursor, "tasks")) &&
			(existsSync(join(cursor, "knowledge")) || existsSync(join(cursor, "context")))
		) {
			return cursor;
		}
		prev = cursor;
		cursor = join(cursor, "..");
		if (cursor === prev) break;
	}
	return null;
}

function gateStatePath(orgDir: string): string {
	return join(orgDir, ".omp", "maintenance-gate-state.json");
}

function readGateState(orgDir: string): GateDiskState {
	try {
		const path = gateStatePath(orgDir);
		if (!existsSync(path)) return { lastFireMs: 0 };
		const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<GateDiskState>;
		return { lastFireMs: typeof data.lastFireMs === "number" ? data.lastFireMs : 0 };
	} catch {
		return { lastFireMs: 0 };
	}
}

function writeGateState(orgDir: string, state: GateDiskState): void {
	try {
		const dir = join(orgDir, ".omp");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(gateStatePath(orgDir), JSON.stringify(state, null, 2));
	} catch {
		/* best-effort */
	}
}

function buildReminder(): string {
	const deckMode = !!process.env.OMP_DECK_ORG_ROOT?.trim();

	// In deck-managed sessions, kanban + inbox live behind the REST API; file
	// paths like `inbox/captures/foo.md` resolve nowhere useful. Flat-file
	// orgs keep the original on-disk paths. Both modes route insights and
	// skills to files because no REST surface owns them.
	const rows: [string, string][] = deckMode
		? [
				["Reusable insight or pattern", "→ `kb://system/<topic>.md`"],
				["Project status changed", "→ `POST /api/inbox` with `kind: \"capture\"` describing the change; daily briefing reconciles into `kb://system/projects-hub.md`"],
				["New task identified", "→ `POST /api/tasks`"],
				["Question worth preserving", "→ `POST /api/inbox` with `kind: \"capture\"` (or `kind: \"investigation\"` if you intend to follow up)"],
				["Feature idea / future project", "→ `POST /api/inbox` with `kind: \"idea\"`"],
				["Decision needed", "→ `POST /api/inbox` with `kind: \"decision\"`"],
				["Bug to investigate", "→ `POST /api/inbox` with `kind: \"investigation\"`"],
				["Quick unsorted capture", "→ `POST /api/inbox` with `kind: \"capture\"`"],
				["New capability learned", "→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)"],
			]
		: [
				["Reusable insight or pattern", "→ `knowledge/<subfolder>/<topic>.md`"],
				["Project status changed", "→ update `context/current-state.md`"],
				["New task identified", "→ `tasks/<name>.md`"],
				["Question worth preserving", "→ `queries/<question>.md`"],
				["Feature idea / future project", "→ `inbox/ideas/<item>.md`"],
				["Decision needed", "→ `inbox/decisions/<item>.md`"],
				["Bug to investigate", "→ `inbox/investigations/<item>.md`"],
				["Quick unsorted capture", "→ `inbox/captures/<item>.md`"],
				["New capability learned", "→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)"],
			];

	const releaseClause = deckMode
		? "invoking any of the REST endpoints below (or writing to one of the listed paths)"
		: "writing to any of the paths below";

	return [
		"---",
		"",
		FIRE_MARKER,
		"",
		`Did this segment of work produce any of the signals below? Capture **now** — ${releaseClause} releases this check automatically. If nothing applies, state the literal phrase "${NO_MAINT_PHRASE}" to release.`,
		"",
		"| Signal | Action if present |",
		"|--------|-------------------|",
		...rows.map(([signal, action]) => `| ${signal} | ${action} |`),
		"",
		"Be aggressive about capture — lost insights are unrecoverable.",
		"",
		"---",
	].join("\n");
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
	if (depth > 6) return;
	if (value == null) return;
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectStrings(v, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			collectStrings(v, out, depth + 1);
		}
	}
}

function flattenText(value: unknown): string {
	const parts: string[] = [];
	collectStrings(value, parts);
	return parts.join("\n");
}

function extractRole(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { role?: unknown; message?: { role?: unknown } };
	if (typeof v.role === "string") return v.role;
	if (v.message && typeof v.message === "object") {
		const r = (v.message as { role?: unknown }).role;
		if (typeof r === "string") return r;
	}
	return null;
}

/**
 * Count real operator messages (user-role entries that are NOT one of the
 * gate's own injected follow-ups) at branch indices `>= fromIdx`. This is
 * the load-bearing "has the operator done meaningful work since the
 * release cursor?" signal.
 */
function countRealOperatorMsgsAfter(branch: readonly unknown[], fromIdx: number): number {
	let count = 0;
	for (let i = Math.max(0, fromIdx); i < branch.length; i++) {
		const entry = branch[i];
		if (extractRole(entry) !== "user") continue;
		const text = flattenText(entry);
		if (text.includes(FIRE_MARKER)) continue;
		count++;
	}
	return count;
}

/**
 * Defense-in-depth: scan branch >= cursor for a fire marker already
 * present (i.e. a previous attempt already injected, but state was lost).
 * Caps the look at a window so we don't walk huge branches.
 */
function branchHasFireMarkerSince(branch: readonly unknown[], cursor: number): boolean {
	const start = Math.max(0, cursor);
	for (let i = start; i < branch.length; i++) {
		const entry = branch[i];
		if (extractRole(entry) !== "user") continue;
		const text = flattenText(entry);
		if (text.includes(FIRE_MARKER)) return true;
	}
	return false;
}

function normalizeToolName(name: string): string {
	return name.startsWith("proxy_") ? name.slice("proxy_".length) : name;
}

function pathFromToolInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const candidates = [obj.file_path, obj.path, obj.target, obj.filePath];
	for (const c of candidates) {
		if (typeof c === "string") return c;
	}
	try {
		return JSON.stringify(obj);
	} catch {
		return "";
	}
}

function looksLikeCapture(target: string): boolean {
	return CAPTURE_PATH_RE.test(target) || SKILL_PATH_RE.test(target);
}

function bashCommandFromInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const candidates = [obj.command, obj.cmd, obj.script, obj.code];
	for (const c of candidates) {
		if (typeof c === "string") return c;
	}
	return "";
}

function looksLikeDeckCapture(command: string): boolean {
	return DECK_CAPTURE_PATH_RE.test(command) && DECK_CAPTURE_VERB_RE.test(command);
}

// ─── extension entry ───────────────────────────────────────────────────────

export default function maintenanceGate(pi: ExtensionAPI): void {
	let profile: Profile = "inactive";
	let orgDir: string | null = null;

	const state: GateState = {
		releaseCursorBranchLength: -1,
		releaseCursorTimeMs: 0,
		lastFireBranchLength: -1,
		firingNow: false,
	};

	function advanceReleaseCursor(branch: readonly unknown[]): void {
		state.releaseCursorBranchLength = branch.length;
		state.releaseCursorTimeMs = Date.now();
	}

	pi.on("session_start", async (_event, ctx) => {
		orgDir = detectOrgRoot(ctx.cwd);
		profile = orgDir ? "active" : "inactive";
		if (!orgDir) return;

		// Initialize the release cursor at session-start so we never fire
		// the moment a fresh session resumes against an already-large branch.
		const branch = ctx.sessionManager.getBranch();
		state.releaseCursorBranchLength = branch.length;
		state.releaseCursorTimeMs = Date.now();
		state.lastFireBranchLength = -1;
		state.firingNow = false;
		pi.logger?.info?.(`maintenance-gate: active for org root ${orgDir}`);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (profile === "inactive" || !orgDir) return;
		const tn = normalizeToolName(event.toolName);
		// File-write captures (flat-file orgs + kb writes).
		if (tn === "write" || tn === "edit") {
			const target = pathFromToolInput(event.input);
			if (target && looksLikeCapture(target)) {
				advanceReleaseCursor(ctx.sessionManager.getBranch());
			}
			return;
		}
		// Deck REST captures (POST/PATCH /api/inbox|tasks, POST/PUT /api/kb/file)
		// invoked via bash curl or eval fetch. Both tools expose the executed
		// string under `command`/`code`.
		if (tn === "bash" || tn === "eval") {
			const cmd = bashCommandFromInput(event.input);
			if (cmd && looksLikeDeckCapture(cmd)) {
				advanceReleaseCursor(ctx.sessionManager.getBranch());
			}
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (profile === "inactive" || !orgDir) return;
		if (extractRole(event) !== "assistant") return;
		const text = flattenText(event);
		if (text.includes(NO_MAINT_PHRASE)) {
			advanceReleaseCursor(ctx.sessionManager.getBranch());
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (profile === "inactive" || !orgDir) return;
		// Live kill switch: a mid-session disable (Settings → Orientation)
		// short-circuits before any further evaluation. Cheap; runs at most
		// once per turn boundary.
		if (isGateDisabled()) return;

		// Re-entry guard: the turn_end immediately after we synthesize is
		// ours; skip it without touching any cursors.
		if (state.firingNow) {
			state.firingNow = false;
			return;
		}

		const now = Date.now();
		const branch = ctx.sessionManager.getBranch();

		// FLOOR 1 — cross-session wall-clock minimum between fires.
		const disk = readGateState(orgDir);
		if (disk.lastFireMs > 0 && now - disk.lastFireMs < getMinTimeBetweenFiresMs()) {
			return;
		}

		// INVARIANT — at most one fire per release segment.
		// If we've already fired since the most recent release, wait for
		// the next release to advance the cursor before re-arming.
		if (
			state.lastFireBranchLength >= 0 &&
			state.lastFireBranchLength >= state.releaseCursorBranchLength
		) {
			return;
		}

		// FLOOR 2 — wall-clock since the current release cursor. Prevents
		// firing right after the user just released the previous segment.
		if (now - state.releaseCursorTimeMs < getMinTimeSinceReleaseMs()) {
			return;
		}

		// FLOOR 3 — operator messages since the current release cursor.
		// One trivial "continue" should never re-trigger.
		const opMsgs = countRealOperatorMsgsAfter(
			branch,
			Math.max(0, state.releaseCursorBranchLength),
		);
		if (opMsgs < getMinOpMsgsSinceRelease()) return;

		// DEFENSE-IN-DEPTH — if the branch already contains a fire marker
		// in this segment (e.g. state was lost mid-session), don't fire
		// again until release advances past it.
		if (branchHasFireMarkerSince(branch, state.releaseCursorBranchLength)) {
			// Treat the existing marker as our fire for this segment.
			state.lastFireBranchLength = branch.length;
			return;
		}

		// Commit fire state BEFORE async send so a concurrent turn_end can
		// see the new lastFireBranchLength and bail on the invariant check.
		state.firingNow = true;
		const previousLastFireBranchLength = state.lastFireBranchLength;
		state.lastFireBranchLength = branch.length;
		writeGateState(orgDir, { lastFireMs: now });

		try {
			await pi.sendUserMessage(buildReminder(), { deliverAs: "followUp" });
			pi.logger?.info?.(
				`maintenance-gate: fired (branch=${branch.length}, opMsgsSinceRelease=${opMsgs})`,
			);
		} catch (err) {
			pi.logger?.warn?.(
				`maintenance-gate: sendUserMessage failed: ${(err as Error)?.message ?? String(err)}`,
			);
			state.firingNow = false;
			state.lastFireBranchLength = previousLastFireBranchLength;
			writeGateState(orgDir, disk);
		}
	});
}
