import type {
	ListMcpToolsResponse,
	McpHealthResponse,
	McpServerEntry,
	ToggleMcpToolResponse,
} from "@omp-deck/protocol";

/**
 * Typed fetch wrapper for `/api/mcp/*` endpoints. Best-effort: if the
 * server is down we return empty/null shapes so the UI stays mountable.
 */
const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) {
		let detail = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { error?: unknown };
			if (body && typeof body.error === "string") detail = body.error;
		} catch {
			// body wasn't JSON — fall through with status code.
		}
		throw new Error(`mcpApi ${path} failed (${res.status}): ${detail}`);
	}
	return (await res.json()) as T;
}

async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch {
		return fallback;
	}
}

export const mcpApi = {
	mcpHealth(): Promise<McpHealthResponse> {
		return safe({ status: [], probedAt: new Date(0).toISOString() }, () => req<McpHealthResponse>("/mcp/health"));
	},
	installMcpServer(
		name: string,
		config: McpServerEntry,
	): Promise<{ ok: boolean; name?: string; error?: string } | null> {
		return safe(null, () =>
			req<{ ok: boolean; name?: string; error?: string }>("/mcp/install", {
				method: "POST",
				body: JSON.stringify({ name, config }),
			}),
		);
	},
	probeMcpServers(): Promise<{ ok: boolean }> {
		return safe({ ok: false }, () => req<{ ok: boolean }>("/mcp/probe-now", { method: "POST" }));
	},
	mcpTools(name: string): Promise<ListMcpToolsResponse | null> {
		return safe(null, () => req<ListMcpToolsResponse>(`/mcp/${encodeURIComponent(name)}/tools`));
	},
	toggleMcpTool(
		name: string,
		tool: string,
		enabled: boolean,
	): Promise<ToggleMcpToolResponse | null> {
		return safe(null, () =>
			req<ToggleMcpToolResponse>(
				`/mcp/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}/toggle`,
				{
					method: "POST",
					body: JSON.stringify({ enabled }),
				},
			),
		);
	},
};
