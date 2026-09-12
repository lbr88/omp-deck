/**
 * Routine template engine. Handlebars-style `{{ expr }}` substitution over the
 * run context (run, trigger, steps, env, secrets, state). Used by every step
 * type for fields that accept templating (command, url, path, content, args,
 * prompt, etc.).
 *
 * Behavior:
 *   - If the template is structurally `^\s*{{ expr }}\s*$` (one expression,
 *     possibly with whitespace), `render` returns the evaluated value
 *     directly — preserving type. This is what makes `query: "{{ state.X }}"`
 *     pass the underlying object/array/number through to the http step's
 *     query builder rather than stringifying it.
 *   - Otherwise the template is treated as a string with embedded expressions;
 *     each `{{ expr }}` is stringified and concatenated with the surrounding
 *     literal text.
 *
 * Path syntax:
 *   - Dotted: `run.id`, `steps.fetch.json.messages.length`
 *   - Helper pipes: `{{ value | json }}`, `{{ value | length }}`
 *
 * What this is NOT: a full expression language. No arithmetic, no comparisons,
 * no function calls. For those, use a `transform` step (sandboxed JS).
 *
 * Why a custom engine vs Handlebars/Mustache/etc.: the corpus is tiny (8
 * helpers max, simple path access), the runtime is hot (every step renders
 * its body), and a 60-line implementation removes a dependency from the
 * server's hot path.
 */

import i18n from "../i18n.ts";

const SOLO_TEMPLATE_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const TEMPLATE_RE = /\{\{\s*([\s\S]+?)\s*\}\}/g;

type Helper = (value: unknown) => unknown;

const HELPERS: Record<string, Helper> = {
	json: (v) => JSON.stringify(v),
	length: (v) => {
		if (Array.isArray(v)) return v.length;
		if (typeof v === "string") return v.length;
		if (v && typeof v === "object") return Object.keys(v as object).length;
		return 0;
	},
};

/**
 * Render a template against the run context. Returns the evaluated value
 * (preserving type) when the template is a single bare expression; otherwise
 * a string with embedded expressions interpolated.
 */
export function render(template: string, context: Record<string, unknown>): unknown {
	const solo = SOLO_TEMPLATE_RE.exec(template);
	if (solo && solo[1] !== undefined) {
		return evalExpression(solo[1], context);
	}
	return template.replace(TEMPLATE_RE, (_match, rawExpr: string) => {
		const value = evalExpression(rawExpr, context);
		return stringify(value);
	});
}

/**
 * Render a template and force string output. Use when the caller needs a
 * string regardless of template shape (file paths, URLs, command strings).
 */
export function renderString(template: string, context: Record<string, unknown>): string {
	const value = render(template, context);
	return stringify(value);
}

function evalExpression(rawExpr: string, context: Record<string, unknown>): unknown {
	// Split on `|` for helper application. Path is first segment.
	const parts = rawExpr.split("|").map((p) => p.trim());
	const pathSegment = parts[0];
	if (pathSegment === undefined || pathSegment.length === 0) return undefined;

	let value: unknown = lookupPath(pathSegment, context);
	for (let i = 1; i < parts.length; i++) {
		const helperName = parts[i];
		if (helperName === undefined) continue;
		const helper = HELPERS[helperName];
		if (!helper) {
			throw new Error(
				i18n.t("template: unknown helper '{{helper}}' (known: {{known}})", {
					helper: helperName,
					known: Object.keys(HELPERS).join(", "),
				}),
			);
		}
		value = helper(value);
	}
	return value;
}

function lookupPath(path: string, context: unknown): unknown {
	const segments = path.split(".");
	let current: unknown = context;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== "object" && typeof current !== "string") return undefined;
		// JS native property access handles array.length, string.length, etc.
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Coerce a template value to a string for interpolation in a larger template.
 * Objects/arrays are JSON-stringified — the conventional behavior for
 * agent-prompt templates (the LLM sees JSON, not '[object Object]').
 */
function stringify(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return value.toString();
	// Object/array → JSON. The agent will parse it back if needed.
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
