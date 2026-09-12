/**
 * Dependency-free i18n + logging indirection for the shared session-core
 * modules (session-core.ts, plan-mode-bridge.ts, ext-ui-bridge.ts).
 *
 * These files are loaded in two very different environments:
 *
 *  1. Inside the deck server — where the real deck i18n (i18next with en/zh
 *     dictionaries) and the deck's log.ts formatting are available.
 *  2. Inside a remote `omp --mode rpc` host extension — where only the omp
 *     SDK + Bun builtins exist and no node_modules are installed. The deck's
 *     i18next dictionary cannot ride along, so the shared modules must not
 *     import deck modules.
 *
 * This module gives both sides a single seam: the deck calls
 * `setBridgeContext(...)` at boot to restore its exact i18n/log behavior;
 * the host never calls it and gets the built-in defaults (English
 * interpolation, console output). Nothing here imports anything outside
 * this file, so it is safe to copy alongside the shared session files.
 */

type LogFn = (msg: string, extra?: unknown) => void;

export interface BridgeLog {
	debug: LogFn;
	info: LogFn;
	warn: LogFn;
	error: LogFn;
}

/** i18next-compatible `t` — the deck plugs its real instance in here. */
export type BridgeT = (key: string, vars?: Record<string, unknown>) => string;

interface BridgeContextState {
	/** Key translator. Default: simple `{{var}}` interpolation of the key itself. */
	t: BridgeT;
	/** Logger factory keyed by scope. Default: console with `[scope]` prefix. */
	logFactory: (scope: string) => BridgeLog;
}

/** Minimal `{{var}}` interpolation mirroring the i18next syntax used by callers. */
function interpolate(key: string, vars?: Record<string, unknown>): string {
	if (!vars) return key;
	return key.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		name in vars ? String(vars[name]) : match,
	);
}

function consoleLog(scope: string): BridgeLog {
	const emit: LogFn = (msg, extra) => {
		if (extra === undefined) {
			// eslint-disable-next-line no-console
			console.log(`[${scope}] ${msg}`);
		} else {
			// eslint-disable-next-line no-console
			console.log(`[${scope}] ${msg}`, extra);
		}
	};
	return { debug: emit, info: emit, warn: emit, error: emit };
}

const state: BridgeContextState = {
	t: interpolate,
	logFactory: consoleLog,
};

export function setBridgeContext(opts: {
	t?: BridgeT;
	logFactory?: (scope: string) => BridgeLog;
}): void {
	if (opts.t) state.t = opts.t;
	if (opts.logFactory) state.logFactory = opts.logFactory;
}

/** Translate a user-facing string; deck installs i18next via setBridgeContext. */
export function bridgeT(key: string, vars?: Record<string, unknown>): string {
	return state.t(key, vars);
}

/** Scoped logger; deck installs log.ts via setBridgeContext. */
export function bridgeLog(scope: string): BridgeLog {
	return state.logFactory(scope);
}
