import type {
	ListMachinesResponse,
	MachineInfo,
	RegisterMachineRequest,
	UpdateMachineRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const machinesApi = {
	list(): Promise<ListMachinesResponse> {
		return req<ListMachinesResponse>("/machines");
	},
	register(body: RegisterMachineRequest): Promise<{ ok: boolean; id: string }> {
		return req(`/machines`, { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateMachineRequest): Promise<{ ok: boolean; id: string }> {
		return req(`/machines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	env(id: string): Promise<import("@omp-deck/protocol").ListEnvSettingsResponse> {
		return req(`/machines/${encodeURIComponent(id)}/env`);
	},
	patchEnv(
		id: string,
		updates: Record<string, string | null>,
	): Promise<import("@omp-deck/protocol").ListEnvSettingsResponse> {
		return req(`/machines/${encodeURIComponent(id)}/env`, {
			method: "PATCH",
			body: JSON.stringify({ updates }),
		});
	},
	models(id: string): Promise<import("@omp-deck/protocol").ListModelsResponse> {
		return req(`/machines/${encodeURIComponent(id)}/models`);
	},
};

export type { MachineInfo };
