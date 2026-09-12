/**
 * `set_state` step: UPSERT key/value pairs into routine_state. Values are
 * templated; objects/arrays preserved through render() value-mode.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import { render } from "../template.ts";
import { saveState } from "../state.ts";
import type { RunContext, StepResult } from "../types.ts";

export async function executeSetStateStep(
	step: Extract<RoutineStep, { type: "set_state" }>,
	context: RunContext,
	_signal: AbortSignal,
	routineId: string,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		const resolved: Record<string, unknown> = {};
		for (const [key, raw] of Object.entries(step.state)) {
			if (typeof raw === "string") {
				resolved[key] = render(raw, context as unknown as Record<string, unknown>);
			} else {
				resolved[key] = raw;
			}
		}
		saveState(routineId, resolved);
		return {
			status: "success",
			stdoutExcerpt: i18n.t("persisted {{count}} key(s)", { count: Object.keys(resolved).length }),
			stderrExcerpt: "",
			json: resolved,
			durationMs: Date.now() - startedMs,
		};
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: String(err),
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}
