/**
 * `write` step: render a templated file body and either overwrite or append.
 * Relative paths resolve against the routine's defaultCwd; mkdir -p the parent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

export async function executeWriteStep(
	step: Extract<RoutineStep, { type: "write" }>,
	context: RunContext,
	_signal: AbortSignal,
	defaultCwd: string,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		const rel = renderString(step.path, context as unknown as Record<string, unknown>);
		const target = path.isAbsolute(rel) ? rel : path.join(defaultCwd, rel);
		const content = renderString(step.content, context as unknown as Record<string, unknown>);
		await fs.mkdir(path.dirname(target), { recursive: true });
		if (step.append) {
			await fs.appendFile(target, content, "utf-8");
		} else {
			await fs.writeFile(target, content, "utf-8");
		}
		return {
			status: "success",
			stdoutExcerpt: step.append
				? i18n.t("wrote {{bytes}} bytes to {{target}} (append)", {
						bytes: content.length,
						target,
					})
				: i18n.t("wrote {{bytes}} bytes to {{target}}", { bytes: content.length, target }),
			stderrExcerpt: "",
			json: { path: target, bytes: content.length, append: !!step.append },
			durationMs: Date.now() - startedMs,
		};
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}
