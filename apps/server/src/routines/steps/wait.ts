/**
 * `wait` step: sleep N seconds. Abortable.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import type { StepResult } from "../types.ts";

export async function executeWaitStep(
	step: Extract<RoutineStep, { type: "wait" }>,
	_context: unknown,
	signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	const durationMs = step.duration_secs * 1000;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, durationMs);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
	if (signal.aborted) {
		return {
			status: "aborted",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: i18n.t("aborted during wait"),
			durationMs: Date.now() - startedMs,
		};
	}
	return {
		status: "success",
		stdoutExcerpt: i18n.t("waited {{secs}}s", { secs: step.duration_secs }),
		stderrExcerpt: "",
		durationMs: Date.now() - startedMs,
	};
}
