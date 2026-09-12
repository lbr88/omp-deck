/**
 * Machines REST surface — remote agent-host registry + live status + env/
 * model proxying. Mounted at `/api/machines`.
 *
 * Registry CRUD persists to machines.json immediately; live connections are
 * spawned/updated on demand (add/update/remove take effect on the next
 * request — no hot re-connect of existing sessions).
 */
import { Hono } from "hono";
import type {
	ListMachinesResponse,
	ListModelsResponse,
	ListEnvSettingsResponse,
	MachineInfo,
	PatchEnvSettingsRequest,
	RegisterMachineRequest,
	UpdateMachineRequest,
} from "@omp-deck/protocol";

import i18n from "./i18n.ts";
import { logger } from "./log.ts";
import type { MachineRegistry } from "./machines.ts";
import type { MultiAgentBridge } from "./bridge/multi.ts";

const log = logger("routes:machines");

export function buildMachinesRouter(registry: MachineRegistry, bridge: MultiAgentBridge): Hono {
	const app = new Hono();

	app.get("/machines", async (c) => {
		const status = bridge.machineStatus();
		const machines: MachineInfo[] = await Promise.all(
			status.map(async (m) => {
				const info: MachineInfo = {
					id: m.id,
					name: m.name,
					baseUrl: m.baseUrl,
					online: m.online,
					sessionCount: m.sessionCount,
					...(m.defaultCwd ? { defaultCwd: m.defaultCwd } : {}),
				};
				if (m.online) {
					try {
						const entry = registry.get(m.id);
						if (entry) {
							const res = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/host/models`, {
								headers: { Authorization: `Bearer ${entry.token}` },
							});
							if (res.ok) {
								const body = (await res.json()) as { models?: unknown[] };
								info.modelCount = Array.isArray(body.models) ? body.models.length : 0;
							}
						}
					} catch (err) {
						log.warn(`modelCount probe failed for ${m.id}`, err);
					}
				}
				return info;
			}),
		);
		const body: ListMachinesResponse = { machines };
		return c.json(body);
	});

	app.post("/machines", async (c) => {
		let body: RegisterMachineRequest;
		try {
			body = (await c.req.json()) as RegisterMachineRequest;
		} catch {
			return c.json({ error: i18n.t("invalid json body") }, 400);
		}
		try {
			registry.add({
				id: body.id,
				name: body.name,
				baseUrl: body.baseUrl,
				token: body.token,
				...(body.defaultCwd ? { defaultCwd: body.defaultCwd } : {}),
			});
			bridge.addMachine(registry.get(body.id)!);
			return c.json({ ok: true, id: body.id }, 201);
		} catch (err) {
			const message = String((err as Error).message ?? err);
			const status = message.includes("already exists") ? 409 : 400;
			return c.json({ error: message }, status);
		}
	});

	app.patch("/machines/:id", async (c) => {
		const id = c.req.param("id");
		let body: UpdateMachineRequest;
		try {
			body = (await c.req.json()) as UpdateMachineRequest;
		} catch {
			return c.json({ error: i18n.t("invalid json body") }, 400);
		}
		const patch: Partial<import("./machines.ts").MachineEntry> = {};
		if (body.name !== undefined) patch.name = body.name;
		if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
		if (body.token !== undefined) patch.token = body.token;
		if (body.defaultCwd !== undefined) patch.defaultCwd = body.defaultCwd;
		try {
			const updated = registry.update(id, patch);
			if (!updated) return c.json({ error: i18n.t("not found") }, 404);
			// Reconnect with the new endpoint/token.
			bridge.removeMachine(id);
			bridge.addMachine(updated);
			return c.json({ ok: true, id });
		} catch (err) {
			return c.json({ error: String((err as Error).message ?? err) }, 400);
		}
	});

	app.delete("/machines/:id", (c) => {
		const id = c.req.param("id");
		const removed = registry.remove(id);
		if (!removed) return c.json({ error: i18n.t("not found") }, 404);
		bridge.removeMachine(id);
		return c.json({ ok: true });
	});

	// ─── Proxies ─────────────────────────────────────────────────────────

	async function machineOr404(id: string): Promise<import("./machines.ts").MachineEntry | Response> {
		const entry = registry.get(id);
		if (!entry) return c404();
		return entry;
	}
	function c404(): Response {
		return Response.json({ error: i18n.t("not found") }, { status: 404 });
	}
	function authHeaders(entry: import("./machines.ts").MachineEntry): Record<string, string> {
		return { Authorization: `Bearer ${entry.token}` };
	}
	function base(entry: import("./machines.ts").MachineEntry): string {
		return entry.baseUrl.replace(/\/+$/, "");
	}

	app.get("/machines/:id/models", async (c) => {
		const entry = await machineOr404(c.req.param("id"));
		if (entry instanceof Response) return entry;
		try {
			const res = await fetch(`${base(entry)}/host/models`, { headers: authHeaders(entry) });
			if (!res.ok) return c.json({ error: `host error ${res.status}` }, 502);
			return c.json((await res.json()) as ListModelsResponse);
		} catch (err) {
			log.warn(`models proxy failed for ${entry.id}`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 502);
		}
	});

	app.get("/machines/:id/env", async (c) => {
		const entry = await machineOr404(c.req.param("id"));
		if (entry instanceof Response) return entry;
		try {
			const res = await fetch(`${base(entry)}/host/env`, { headers: authHeaders(entry) });
			if (!res.ok) return c.json({ error: `host error ${res.status}` }, 502);
			return c.json((await res.json()) as ListEnvSettingsResponse);
		} catch (err) {
			log.warn(`env proxy failed for ${entry.id}`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 502);
		}
	});

	app.patch("/machines/:id/env", async (c) => {
		const entry = await machineOr404(c.req.param("id"));
		if (entry instanceof Response) return entry;
		let body: PatchEnvSettingsRequest;
		try {
			body = (await c.req.json()) as PatchEnvSettingsRequest;
		} catch {
			return c.json({ error: i18n.t("invalid json body") }, 400);
		}
		try {
			const res = await fetch(`${base(entry)}/host/env`, {
				method: "PATCH",
				headers: { ...authHeaders(entry), "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				return c.json({ error: text || `host error ${res.status}` }, 502);
			}
			return c.json((await res.json()) as ListEnvSettingsResponse);
		} catch (err) {
			log.warn(`env patch proxy failed for ${entry.id}`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 502);
		}
	});

	return app;
}
