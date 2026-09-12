/**
 * Tiny utility routes the editor can poll while the user is typing:
 *   GET /api/cron/validate?expr=… → { valid, error?, nextRuns: string[] }
 *   GET /api/binary/which?name=…  → { found, path? }
 *
 * Both are stateless. Kept here so the main router doesn't accrete more
 * one-off endpoints in `routes.ts`.
 */

import { Hono } from "hono";
import { Cron } from "croner";

import i18n from "./i18n";

export function buildUtilityRouter(): Hono {
	const app = new Hono();

	app.get("/cron/validate", (c) => {
		const expr = c.req.query("expr")?.trim() ?? "";
		if (!expr) return c.json({ valid: false, error: i18n.t("empty expression"), nextRuns: [] });
		try {
			const cron = new Cron(expr, { paused: true });
			const nextRuns: string[] = [];
			let cursor = new Date();
			for (let i = 0; i < 5; i++) {
				const next = cron.nextRun(cursor);
				if (!next) break;
				nextRuns.push(next.toISOString());
				cursor = new Date(next.getTime() + 1000);
			}
			cron.stop();
			return c.json({ valid: true, nextRuns });
		} catch (err) {
			return c.json({
				valid: false,
				error: err instanceof Error ? err.message : String(err),
				nextRuns: [],
			});
		}
	});

	app.get("/binary/which", (c) => {
		const name = c.req.query("name")?.trim() ?? "";
		if (!name) return c.json({ found: false });
		try {
			const found = Bun.which(name);
			return c.json({ found: Boolean(found), path: found ?? undefined });
		} catch {
			return c.json({ found: false });
		}
	});

	return app;
}
