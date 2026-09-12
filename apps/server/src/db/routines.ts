/**
 * Routines + routine_runs queries.
 *
 * `next_run_at` is recomputed whenever a routine is created/updated or fires,
 * driven by the in-process runner. We persist it so a server restart can
 * rebuild the schedule without re-evaluating every cron expression up front.
 */

import type {
	Routine,
	RoutineActionKind,
	RoutineBudget,
	RoutineConcurrency,
	RoutineRun,
} from "@omp-deck/protocol";

import i18n from "../i18n.ts";
import { getDb, id, nowIso } from "./index.ts";

interface RoutineRow {
	id: string;
	name: string;
	description: string;
	cron: string;
	action_kind: string;
	action_body: string;
	action_cwd: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
	last_run_at: string | null;
	next_run_at: string | null;
	// V1 columns (003-routines-v1)
	spec_yaml: string | null;
	concurrency: string;
	budget_json: string | null;
	tags: string | null;
	timezone: string | null;
	spec_version: number;
}

interface RunRow {
	id: string;
	routine_id: string;
	started_at: string;
	ended_at: string | null;
	exit_code: number | null;
	stdout_excerpt: string;
	stderr_excerpt: string;
	error: string | null;
	trigger: string;
	// V1 columns (003-routines-v1)
	trigger_payload: string | null;
	total_llm_tokens: number;
	total_llm_cost_micros: number;
	aborted_at: string | null;
	abort_reason: string | null;
	step_count_total: number;
	step_count_failed: number;
}

function rowToRoutine(r: RoutineRow): Routine {
	const specVersion = (r.spec_version === 1 ? 1 : 0) as 0 | 1;
	const out: Routine = {
		id: r.id,
		name: r.name,
		description: r.description,
		cron: r.cron,
		actionKind: r.action_kind as RoutineActionKind,
		actionBody: r.action_body,
		enabled: r.enabled === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		specVersion,
		concurrency: r.concurrency as RoutineConcurrency,
	};
	if (r.action_cwd !== null) out.actionCwd = r.action_cwd;
	if (r.last_run_at !== null) out.lastRunAt = r.last_run_at;
	if (r.next_run_at !== null) out.nextRunAt = r.next_run_at;
	if (r.spec_yaml !== null) out.specYaml = r.spec_yaml;
	if (r.timezone !== null) out.timezone = r.timezone;
	if (r.budget_json !== null) {
		try {
			out.budget = JSON.parse(r.budget_json) as RoutineBudget;
		} catch {
			/* malformed JSON in budget_json — silently drop; preserves row visibility */
		}
	}
	if (r.tags !== null && r.tags.length > 0) {
		out.tags = r.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
	}
	return out;
}

function rowToRun(r: RunRow): RoutineRun {
	const out: RoutineRun = {
		id: r.id,
		routineId: r.routine_id,
		startedAt: r.started_at,
		stdoutExcerpt: r.stdout_excerpt,
		stderrExcerpt: r.stderr_excerpt,
		trigger: r.trigger as RoutineRun["trigger"],
		totalLlmTokens: r.total_llm_tokens,
		totalLlmCostMicros: r.total_llm_cost_micros,
		stepCountTotal: r.step_count_total,
		stepCountFailed: r.step_count_failed,
	};
	if (r.ended_at !== null) out.endedAt = r.ended_at;
	if (r.exit_code !== null) out.exitCode = r.exit_code;
	if (r.error !== null) out.error = r.error;
	if (r.trigger_payload !== null) out.triggerPayload = r.trigger_payload;
	if (r.aborted_at !== null) out.abortedAt = r.aborted_at;
	if (r.abort_reason !== null) out.abortReason = r.abort_reason;
	return out;
}

export function listRoutines(): Routine[] {
	const rows = getDb()
		.query<RoutineRow, []>(
			`SELECT id, name, description, cron, action_kind, action_body, action_cwd, enabled,
			        created_at, updated_at, last_run_at, next_run_at,
			        spec_yaml, concurrency, budget_json, tags, timezone, spec_version
			 FROM routines ORDER BY name ASC`,
		)
		.all() as RoutineRow[];
	return rows.map(rowToRoutine);
}

export function getRoutine(routineId: string): Routine | undefined {
	const row = getDb()
		.query<RoutineRow, [string]>(
			`SELECT id, name, description, cron, action_kind, action_body, action_cwd, enabled,
			        created_at, updated_at, last_run_at, next_run_at,
			        spec_yaml, concurrency, budget_json, tags, timezone, spec_version
			 FROM routines WHERE id = ?`,
		)
		.get(routineId) as RoutineRow | null;
	return row ? rowToRoutine(row) : undefined;
}

export function createRoutine(input: {
	name: string;
	description?: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled?: boolean;
}): Routine {
	const routineId = `r_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	getDb()
		.prepare<
			unknown,
			[string, string, string, string, string, string, string | null, number, string, string]
		>(
			`INSERT INTO routines
			   (id, name, description, cron, action_kind, action_body, action_cwd, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			routineId,
			input.name,
			input.description ?? "",
			input.cron,
			input.actionKind,
			input.actionBody,
			input.actionCwd ?? null,
			input.enabled === false ? 0 : 1,
			now,
			now,
		);
	const out = getRoutine(routineId);
	if (!out) throw new Error(i18n.t("createRoutine failed"));
	return out;
}

/**
 * Create a V1 (multi-step) routine. Stores spec_yaml as the source of truth;
 * derives `cron` from the first cron trigger (for V0-style queries that look
 * at the column directly), and stuffs concurrency/budget/timezone/tags into
 * their dedicated columns.
 */
export function createV1Routine(input: {
	name: string;
	description?: string;
	specYaml: string;
	spec: import("@omp-deck/protocol").RoutineSpec;
	enabled?: boolean;
}): Routine {
	const routineId = `r_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	const firstCron = input.spec.trigger.find((t) => "cron" in t) as { cron: string } | undefined;
	const cron = firstCron?.cron ?? "";
	const concurrency = input.spec.concurrency ?? "skip";
	const budgetJson = input.spec.budget ? JSON.stringify(input.spec.budget) : null;
	const tags = input.spec.tags?.join(",") ?? null;
	const timezone = input.spec.timezone ?? null;
	getDb()
		.prepare<
			unknown,
			[
				string,
				string,
				string,
				string,
				string,
				string,
				number,
				string,
				string,
				string,
				string,
				string | null,
				string | null,
				string | null,
				number,
			]
		>(
			`INSERT INTO routines
			   (id, name, description, cron, action_kind, action_body, enabled, created_at, updated_at,
			    spec_yaml, concurrency, budget_json, tags, timezone, spec_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			routineId,
			input.name,
			input.description ?? "",
			cron,
			// Sentinel V0 fields — never read for spec_version=1 routines, but
			// must satisfy the NOT NULL + CHECK constraints from 001-init.sql.
			"script",
			"",
			input.enabled === false ? 0 : 1,
			now,
			now,
			input.specYaml,
			concurrency,
			budgetJson,
			tags,
			timezone,
			1,
		);
	const out = getRoutine(routineId);
	if (!out) throw new Error(i18n.t("createV1Routine failed"));
	return out;
}

/**
 * Update a V1 (multi-step) routine. Replaces spec_yaml + derived columns
 * (cron mirror, concurrency, budget_json, tags, timezone) atomically. The
 * `enabled` flag may be patched independently of the spec.
 */
export function updateV1Routine(
	routineId: string,
	patch: {
		name?: string;
		description?: string;
		specYaml?: string;
		spec?: import("@omp-deck/protocol").RoutineSpec;
		enabled?: boolean;
	},
): Routine | undefined {
	const existing = getRoutine(routineId);
	if (!existing) return undefined;
	if (existing.specVersion !== 1) return undefined;
	const now = nowIso();
	if (patch.specYaml !== undefined && patch.spec !== undefined) {
		const spec = patch.spec;
		const firstCron = spec.trigger.find((t) => "cron" in t) as { cron: string } | undefined;
		const cron = firstCron?.cron ?? "";
		const concurrency = spec.concurrency ?? "skip";
		const budgetJson = spec.budget ? JSON.stringify(spec.budget) : null;
		const tags = spec.tags && spec.tags.length > 0 ? spec.tags.join(",") : null;
		const timezone = spec.timezone ?? null;
		const name = patch.name ?? spec.name ?? existing.name;
		const description = patch.description ?? spec.description ?? existing.description;
		const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
		getDb()
			.prepare<
				unknown,
				[string, string, string, string, string, string | null, string | null, string | null, number, string, string]
			>(
				`UPDATE routines SET name = ?, description = ?, cron = ?, spec_yaml = ?, concurrency = ?,
				        budget_json = ?, tags = ?, timezone = ?, enabled = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				name,
				description,
				cron,
				patch.specYaml,
				concurrency,
				budgetJson,
				tags,
				timezone,
				enabled ? 1 : 0,
				now,
				routineId,
			);
	} else if (patch.enabled !== undefined || patch.name !== undefined || patch.description !== undefined) {
		const name = patch.name ?? existing.name;
		const description = patch.description ?? existing.description;
		const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
		getDb()
			.prepare<unknown, [string, string, number, string, string]>(
				`UPDATE routines SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?`,
			)
			.run(name, description, enabled ? 1 : 0, now, routineId);
	}
	return getRoutine(routineId);
}

export function updateRoutine(
	routineId: string,
	patch: Partial<{
		name: string;
		description: string;
		cron: string;
		actionKind: RoutineActionKind;
		actionBody: string;
		actionCwd: string | null;
		enabled: boolean;
	}>,
): Routine | undefined {
	const existing = getRoutine(routineId);
	if (!existing) return undefined;
	const next = { ...existing, ...patch };
	getDb()
		.prepare<
			unknown,
			[string, string, string, string, string, string | null, number, string, string]
		>(
			`UPDATE routines SET name = ?, description = ?, cron = ?, action_kind = ?, action_body = ?,
			        action_cwd = ?, enabled = ?, updated_at = ?
			 WHERE id = ?`,
		)
		.run(
			next.name,
			next.description,
			next.cron,
			next.actionKind,
			next.actionBody,
			(patch.actionCwd === null ? null : (next.actionCwd ?? null)) as string | null,
			next.enabled ? 1 : 0,
			nowIso(),
			routineId,
		);
	return getRoutine(routineId);
}

export function deleteRoutine(routineId: string): boolean {
	const r = getDb().prepare<unknown, [string]>("DELETE FROM routines WHERE id = ?").run(routineId);
	return Number(r.changes ?? 0) > 0;
}

export function setRoutineSchedule(
	routineId: string,
	patch: { lastRunAt?: string; nextRunAt?: string | null },
): void {
	const sets: string[] = [];
	const args: Array<string | null> = [];
	if (patch.lastRunAt !== undefined) {
		sets.push("last_run_at = ?");
		args.push(patch.lastRunAt);
	}
	if (patch.nextRunAt !== undefined) {
		sets.push("next_run_at = ?");
		args.push(patch.nextRunAt);
	}
	if (sets.length === 0) return;
	args.push(routineId);
	getDb()
		.prepare<unknown, (string | null)[]>(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`)
		.run(...args);
}

// ─── Runs ──────────────────────────────────────────────────────────────────

export function startRun(routineId: string, trigger: RoutineRun["trigger"]): RoutineRun {
	const runId = `run_${id().toLowerCase().slice(0, 18)}`;
	const startedAt = nowIso();
	getDb()
		.prepare<unknown, [string, string, string, string]>(
			"INSERT INTO routine_runs (id, routine_id, started_at, trigger) VALUES (?, ?, ?, ?)",
		)
		.run(runId, routineId, startedAt, trigger);
	const out = getRun(runId);
	if (!out) throw new Error(i18n.t("startRun failed"));
	return out;
}

export function finishRun(
	runId: string,
	patch: { exitCode?: number; stdoutExcerpt?: string; stderrExcerpt?: string; error?: string },
): void {
	getDb()
		.prepare<unknown, [string, number | null, string, string, string | null, string]>(
			`UPDATE routine_runs
			   SET ended_at = ?, exit_code = ?, stdout_excerpt = ?, stderr_excerpt = ?, error = ?
			 WHERE id = ?`,
		)
		.run(
			nowIso(),
			patch.exitCode ?? null,
			patch.stdoutExcerpt ?? "",
			patch.stderrExcerpt ?? "",
			patch.error ?? null,
			runId,
		);
}

export function listRuns(routineId: string, limit = 20): RoutineRun[] {
	const rows = getDb()
		.query<RunRow, [string, number]>(
			`SELECT id, routine_id, started_at, ended_at, exit_code, stdout_excerpt, stderr_excerpt, error, trigger,
			        trigger_payload, total_llm_tokens, total_llm_cost_micros, aborted_at, abort_reason,
			        step_count_total, step_count_failed
			 FROM routine_runs
			 WHERE routine_id = ?
			 ORDER BY started_at DESC
			 LIMIT ?`,
		)
		.all(routineId, limit) as RunRow[];
	return rows.map(rowToRun);
}

export function getRun(runId: string): RoutineRun | undefined {
	const row = getDb()
		.query<RunRow, [string]>(
			`SELECT id, routine_id, started_at, ended_at, exit_code, stdout_excerpt, stderr_excerpt, error, trigger,
			        trigger_payload, total_llm_tokens, total_llm_cost_micros, aborted_at, abort_reason,
			        step_count_total, step_count_failed
			 FROM routine_runs WHERE id = ?`,
		)
		.get(runId) as RunRow | null;
	return row ? rowToRun(row) : undefined;
}
