/**
 * `agent` step: shell out to `omp -p <prompt>` headless. Captures stdout as
 * the agent's final text. Structured-output mode appends a JSON schema
 * instruction to the prompt and parses stdout as JSON.
 *
 * V1 caveats — documented for the V1.5 task that revisits this:
 *   - `skills_allowed` and `mcp_servers_allowed` aren't yet plumbed; the agent
 *     runs with its default surface. Will land when the bridge exposes
 *     per-invocation surface restriction.
 *   - Token counts are estimated from prompt+output character length using a
 *     ~4-char-per-token heuristic. Real counts require the in-process bridge
 *     path; cost is BYOK-billed anyway so the estimate is for budget caps
 *     only.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import { costMicros } from "../budget.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";
import { validateRoutineSpec as _vrs } from "@omp-deck/protocol";

void _vrs; // keep import; unused but ensures protocol re-export typechecks here

const MAX_EXCERPT = 8 * 1024;
/** Hard cap on the prompt arg so we don't blow Windows' ~32KB command-line limit. Truncates with a marker. */
const MAX_PROMPT_CHARS = 30 * 1024;
const CHARS_PER_TOKEN = 4;

export async function executeAgentStep(
	step: Extract<RoutineStep, { type: "agent" }>,
	context: RunContext,
	signal: AbortSignal,
	defaultCwd: string,
): Promise<StepResult> {
	const startedMs = Date.now();
	let prompt = renderString(step.prompt, context as unknown as Record<string, unknown>);
	if (step.structured_output) {
		const schemaJson = JSON.stringify(step.structured_output.schema);
		prompt = `${prompt}\n\nRespond with ONLY JSON matching this schema (no prose, no fences):\n${schemaJson}`;
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		prompt = prompt.slice(0, MAX_PROMPT_CHARS) + `\n[prompt truncated at ${MAX_PROMPT_CHARS} chars]`;
	}

	const args = ["-p", prompt];
	if (step.model) {
		args.push("-m", step.model);
	}

	try {
		const proc = Bun.spawn(["omp", ...args], {
			cwd: defaultCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const onAbort = () => {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		signal.addEventListener("abort", onAbort);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				readClipped(proc.stdout),
				readClipped(proc.stderr),
				proc.exited,
			]);
			const durationMs = Date.now() - startedMs;
			if (signal.aborted) {
				return {
					status: "aborted",
					stdoutExcerpt: stdout,
					stderrExcerpt: stderr,
					error: i18n.t("aborted"),
					durationMs,
				};
			}
			if (exitCode !== 0) {
				return {
					status: "failed",
					stdoutExcerpt: stdout,
					stderrExcerpt: stderr,
					error: i18n.t("omp exit code {{code}}", { code: exitCode }),
					durationMs,
				};
			}

			// Estimate tokens for budget tracking. Conservative — model token
			// counts are not exposed by `omp -p` stdout; the V1 estimate is
			// good enough for max_llm_cost_usd to fire on runaway calls.
			const tokensIn = Math.ceil(prompt.length / CHARS_PER_TOKEN);
			const tokensOut = Math.ceil(stdout.length / CHARS_PER_TOKEN);
			const cost = costMicros(step.model, tokensIn, tokensOut);

			let json: unknown;
			let parseError: string | undefined;
			if (step.structured_output) {
				try {
					json = JSON.parse(stdout.trim());
				} catch (err) {
					parseError = i18n.t("structured_output parse failure: {{detail}}", {
						detail: String(err),
					});
				}
				if (step.structured_output.strict !== false && parseError) {
					return {
						status: "failed",
						stdoutExcerpt: stdout,
						stderrExcerpt: stderr,
						error: parseError,
						durationMs,
						model: step.model,
						llmTokensIn: tokensIn,
						llmTokensOut: tokensOut,
						llmCostMicros: cost,
					};
				}
			}

			return {
				status: "success",
				stdoutExcerpt: stdout,
				stderrExcerpt: stderr,
				json,
				durationMs,
				model: step.model,
				llmTokensIn: tokensIn,
				llmTokensOut: tokensOut,
				llmCostMicros: cost,
			};
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
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

async function readClipped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let acc = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
		if (acc.length > MAX_EXCERPT) {
			acc = acc.slice(0, MAX_EXCERPT) + "\n…(truncated)";
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			break;
		}
	}
	acc += decoder.decode();
	return acc;
}
