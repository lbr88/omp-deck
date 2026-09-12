/**
 * `http` step: HTTP request. Localhost requests automatically get the
 * routine-runner's internal bearer token injected so they can hit the deck's
 * own REST API without a user session. Non-localhost calls do NOT receive
 * the token.
 *
 * Templating applies to url, headers (values), query (values), and body
 * (when body is a string).
 */

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import { INTERNAL_AUTH_HEADERS, mintInternalToken } from "../internal-auth.ts";
import { render, renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

const MAX_EXCERPT = 8 * 1024;

export async function executeHttpStep(
	step: Extract<RoutineStep, { type: "http" }>,
	context: RunContext,
	signal: AbortSignal,
	runId: string,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		const url = new URL(renderString(step.url, context as unknown as Record<string, unknown>));
		if (step.query) {
			for (const [key, raw] of Object.entries(step.query)) {
				const value =
					typeof raw === "string"
						? renderString(raw, context as unknown as Record<string, unknown>)
						: String(raw);
				url.searchParams.set(key, value);
			}
		}

		const headers = new Headers();
		if (step.headers) {
			for (const [key, raw] of Object.entries(step.headers)) {
				headers.set(key, renderString(raw, context as unknown as Record<string, unknown>));
			}
		}

		// Inject internal bearer for localhost calls only.
		const isLoopback =
			url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
		if (isLoopback) {
			headers.set(INTERNAL_AUTH_HEADERS.token, mintInternalToken(runId));
			headers.set(INTERNAL_AUTH_HEADERS.runId, runId);
		}

		let body: string | undefined;
		if (step.body !== undefined && step.method !== "GET") {
			if (typeof step.body === "string") {
				body = renderString(step.body, context as unknown as Record<string, unknown>);
				if (!headers.has("content-type")) headers.set("content-type", "text/plain");
			} else {
				// Walk object body, template every leaf string.
				body = JSON.stringify(deepRender(step.body, context as unknown as Record<string, unknown>));
				if (!headers.has("content-type")) headers.set("content-type", "application/json");
			}
		}

		const resp = await fetch(url.toString(), {
			method: step.method,
			headers,
			body,
			signal,
		});
		const text = await resp.text();
		const clipped = text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) + "\n…(truncated)" : text;
		const durationMs = Date.now() - startedMs;

		let json: unknown;
		let parseError: string | undefined;
		if (step.expect_json) {
			try {
				json = JSON.parse(text);
			} catch (err) {
				parseError = i18n.t("expect_json parse failure: {{detail}}", { detail: String(err) });
			}
		}

		if (!resp.ok) {
			return {
				status: "failed",
				stdoutExcerpt: clipped,
				stderrExcerpt: "",
				error: i18n.t("HTTP {{status}} {{statusText}}", {
					status: resp.status,
					statusText: resp.statusText,
				}),
				json,
				durationMs,
			};
		}
		if (step.expect_json && parseError) {
			return {
				status: "failed",
				stdoutExcerpt: clipped,
				stderrExcerpt: "",
				error: parseError,
				durationMs,
			};
		}

		return {
			status: "success",
			stdoutExcerpt: clipped,
			stderrExcerpt: "",
			json,
			durationMs,
		};
	} catch (err) {
		const aborted = err instanceof Error && err.name === "AbortError";
		return {
			status: aborted ? "aborted" : "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}

function deepRender(value: unknown, ctx: Record<string, unknown>): unknown {
	if (typeof value === "string") return render(value, ctx);
	if (Array.isArray(value)) return value.map((v) => deepRender(v, ctx));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = deepRender(v, ctx);
		}
		return out;
	}
	return value;
}
