/**
 * Session-based authentication for the deck's access token.
 *
 * The deck's OMP_DECK_ACCESS_TOKEN is a shared site key. Treating access as
 * a login flow keeps the token out of JS-readable storage entirely:
 *
 *   - POST /api/auth/login   { token, remember? } → validates the token and
 *     sets an HttpOnly, SameSite=Strict session cookie (Secure on https).
 *   - GET  /api/auth/status  → { authenticated } for the bootstrap probe.
 *   - POST /api/auth/logout  → clears the session cookie.
 *
 * The gate middleware accepts EITHER the session cookie OR a `Bearer` header
 * (for API clients / admin scripts); the web client uses only the cookie and
 * never touches the token after login. CSRF is mitigated by SameSite=Strict
 * (same-origin deployment) — there is no cross-site state-change surface.
 */
import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import i18n from "./i18n.ts";

export const AUTH_COOKIE = "omp_deck_session";

/** Constant-time comparison — the token is the only auth boundary. */
export function tokenMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Read a cookie by name from a request. */
export function cookieValue(req: Request, name: string): string | undefined {
	const header = req.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			return decodeURIComponent(part.slice(eq + 1).trim());
		}
	}
	return undefined;
}

/**
 * Authorized? True when no token is configured (loopback mode), or when the
 * request carries a matching Bearer header or session cookie.
 */
export function isSessionAuthed(req: Request, accessToken: string): boolean {
	if (!accessToken) return true;
	const header = req.headers.get("authorization");
	if (header?.startsWith("Bearer ") && tokenMatches(header.slice("Bearer ".length), accessToken)) {
		return true;
	}
	const cookie = cookieValue(req, AUTH_COOKIE);
	return cookie !== undefined && tokenMatches(cookie, accessToken);
}

/** Session cookie; Secure only on https (browsers ignore Secure over http). */
export function sessionCookieHeader(req: Request, token: string, maxAgeSecs?: number): string {
	const secure = new URL(req.url).protocol === "https:";
	const parts = [
		`${AUTH_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
		...(secure ? ["Secure"] : []),
		...(maxAgeSecs !== undefined ? [`Max-Age=${maxAgeSecs}`] : []),
	];
	return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
	return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function buildAuthSessionRouter(opts: { getAccessToken: () => string }): Hono {
	const app = new Hono();

	app.get("/status", (c) => {
		return c.json({ authenticated: isSessionAuthed(c.req.raw, opts.getAccessToken()) });
	});

	app.post("/login", async (c) => {
		const accessToken = opts.getAccessToken();
		if (!accessToken) {
			return c.json({ error: i18n.t("no access token configured on the server") }, 400);
		}
		let body: { token?: unknown; remember?: unknown };
		try {
			body = (await c.req.json()) as { token?: unknown; remember?: unknown };
		} catch {
			return c.json({ error: i18n.t("invalid json body") }, 400);
		}
		if (typeof body.token !== "string" || !tokenMatches(body.token, accessToken)) {
			return c.json({ error: i18n.t("unauthorized") }, 401);
		}
		const maxAge = body.remember === true ? 30 * 24 * 3600 : undefined;
		c.header("Set-Cookie", sessionCookieHeader(c.req.raw, accessToken, maxAge));
		return c.json({ ok: true });
	});

	app.post("/logout", (c) => {
		c.header("Set-Cookie", clearSessionCookieHeader());
		return c.json({ ok: true });
	});

	return app;
}
