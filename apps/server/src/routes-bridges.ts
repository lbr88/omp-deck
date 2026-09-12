import { Hono } from "hono";
import type { BridgeLogsResponse, BridgeName, ListBridgesResponse } from "@omp-deck/protocol";

import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import i18n from "./i18n";
import { logger } from "./log.ts";

const log = logger("routes:bridges");

const KNOWN_BRIDGES = new Set<BridgeName>(["telegram"]);

function parseBridgeName(raw: string): BridgeName | undefined {
	return KNOWN_BRIDGES.has(raw as BridgeName) ? (raw as BridgeName) : undefined;
}

export function buildBridgesRouter(supervisor: BridgeSupervisor): Hono {
	const app = new Hono();

	app.get("/bridges", (c) => {
		const body: ListBridgesResponse = { bridges: supervisor.list() };
		return c.json(body);
	});

	app.get("/bridges/:name", (c) => {
		const name = parseBridgeName(c.req.param("name"));
		if (!name) return c.json({ error: i18n.t("unknown bridge") }, 404);
		return c.json(supervisor.get(name));
	});

	app.post("/bridges/:name/start", async (c) => {
		const name = parseBridgeName(c.req.param("name"));
		if (!name) return c.json({ error: i18n.t("unknown bridge") }, 404);
		try {
			return c.json(await supervisor.start(name));
		} catch (err) {
			log.warn(`start ${name} failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 400);
		}
	});

	app.post("/bridges/:name/stop", async (c) => {
		const name = parseBridgeName(c.req.param("name"));
		if (!name) return c.json({ error: i18n.t("unknown bridge") }, 404);
		try {
			return c.json(await supervisor.stop(name));
		} catch (err) {
			log.warn(`stop ${name} failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/bridges/:name/restart", async (c) => {
		const name = parseBridgeName(c.req.param("name"));
		if (!name) return c.json({ error: i18n.t("unknown bridge") }, 404);
		try {
			return c.json(await supervisor.restart(name));
		} catch (err) {
			log.warn(`restart ${name} failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 400);
		}
	});

	app.get("/bridges/:name/logs", (c) => {
		const name = parseBridgeName(c.req.param("name"));
		if (!name) return c.json({ error: i18n.t("unknown bridge") }, 404);
		const body: BridgeLogsResponse = { name, lines: supervisor.logs(name) };
		return c.json(body);
	});

	return app;
}
