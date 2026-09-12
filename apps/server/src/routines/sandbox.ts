/**
 * Sandboxed JS evaluator for routine `when:` expressions and `transform` step
 * bodies. Backed by quickjs-emscripten — a WASM build of QuickJS that runs in
 * its own isolate, with no host JS reference.
 *
 * Hardening:
 *   - 100ms wall-clock interrupt (configurable but capped)
 *   - No `require`, no `process`, no `fetch`, no DOM, no setTimeout/setInterval
 *   - `context.secrets.*` redacted to '[REDACTED]' before marshaling — even an
 *     adversarial expression cannot exfiltrate them
 *   - Context marshaled via JSON roundtrip (no shared references, no
 *     prototype-pollution attack surface)
 *
 * What this is NOT: a full sandbox for hostile code at unknown origin. The
 * threat model here is "user-authored routine specs that may contain typos
 * or unsafe expressions, in the same trust domain as the deck itself."
 * Sufficient for V1 because routines are tenant-owned and the customer is the
 * principal that benefits from blast-radius containment.
 */

import { getQuickJS, type QuickJSWASMModule } from "quickjs-emscripten";

import i18n from "../i18n.ts";

export interface EvaluateOptions {
	/** Wall-clock limit in milliseconds. Capped at 1000ms; default 100ms. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 1000;

let cached: QuickJSWASMModule | null = null;

async function getRuntime(): Promise<QuickJSWASMModule> {
	if (!cached) cached = await getQuickJS();
	return cached;
}

/**
 * Evaluate `expression` against `context` in a fresh QuickJS VM. Returns the
 * evaluated value, marshaled back via JSON. Throws on syntax errors, runtime
 * errors, or timeout.
 *
 * Use cases:
 *   - `when:` expressions on steps (must return boolean-ish)
 *   - `transform` step bodies (return any JSON-serializable value)
 *
 * The expression is wrapped as `(function(){ return (<expr>); })()` so callers
 * can write either an expression (`steps.X.json.length > 0`) or a statement
 * block with `return` (the daily-briefing's transform step uses this).
 */
export async function evaluate(
	expression: string,
	context: Record<string, unknown>,
	options: EvaluateOptions = {},
): Promise<unknown> {
	const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const QJS = await getRuntime();
	const runtime = QJS.newRuntime();
	const deadline = Date.now() + timeoutMs;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		// Marshal context as JSON (after redacting secrets).
		const redacted = redactSecrets(context);
		const contextJson = JSON.stringify(redacted);
		// Install as `context` global AND bind each top-level field as its
		// own global. This means routine spec authors can write either
		// `steps.X.json` (terse) or `context.steps.X.json` (explicit) and
		// both work; the plan's daily-briefing spec uses both forms.
		const installResult = vm.evalCode(
			"globalThis.context = " + contextJson + ";" +
				"globalThis.run = globalThis.context.run;" +
				"globalThis.trigger = globalThis.context.trigger;" +
				"globalThis.steps = globalThis.context.steps;" +
				"globalThis.env = globalThis.context.env;" +
				"globalThis.secrets = globalThis.context.secrets;" +
				"globalThis.state = globalThis.context.state;",
		);
		if (installResult.error) {
			const err = vm.dump(installResult.error);
			installResult.error.dispose();
			throw new Error(i18n.t("sandbox: failed to install context: {{detail}}", { detail: describeError(err) }));
		}
		installResult.value.dispose();

		// Wrap the expression. The IIFE allows the expression to use `return`
		// (statement form) OR be a bare expression — both forms reach this
		// path because a non-statement expression in the function body is a
		// no-op without `return`. We try the "return (expr);" form first; if
		// it fails to parse, fall back to "expr" assumed-statement-block form.
		let result = vm.evalCode(`(function(){ return (${expression}); })()`);
		if (result.error) {
			// Could be a syntax error from the parentheses wrapping if `expression`
			// is a statement block. Try the bare form.
			result.error.dispose();
			result = vm.evalCode(`(function(){ ${expression} })()`);
			if (result.error) {
				const err = vm.dump(result.error);
				result.error.dispose();
				throw new Error(i18n.t("sandbox: {{detail}}", { detail: describeError(err) }));
			}
		}
		const value = vm.dump(result.value);
		result.value.dispose();
		return value;
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

/**
 * Replace every value under `context.secrets` with the literal string
 * '[REDACTED]'. Deep copy so the caller's context is untouched.
 *
 * We do NOT also scan env.* — env vars are tenant-controlled and may contain
 * legitimately useful values for `when:` expressions (e.g. TZ, DEBUG flags).
 * The convention is: real secrets go in context.secrets; env carries
 * non-sensitive config.
 */
function redactSecrets(context: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...context };
	if (out.secrets && typeof out.secrets === "object" && !Array.isArray(out.secrets)) {
		const redactedSecrets: Record<string, unknown> = {};
		for (const key of Object.keys(out.secrets as object)) {
			redactedSecrets[key] = "[REDACTED]";
		}
		out.secrets = redactedSecrets;
	}
	return out;
}

function describeError(err: unknown): string {
	if (err && typeof err === "object" && "message" in err) {
		const msg = (err as { message: unknown }).message;
		if (typeof msg === "string") return msg;
	}
	return String(err);
}
