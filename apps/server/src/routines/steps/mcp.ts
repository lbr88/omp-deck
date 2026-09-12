/**
 * `mcp` step: invoke a specific MCP server tool. V1 ships a STUB — the SDK's
 * AgentBridge interface doesn't yet expose a direct tool-invocation API; MCP
 * tools are only reachable through an LLM session. V1.5 implements this
 * properly once the bridge gets a `callMcpTool(server, tool, args)` method.
 *
 * Until then, users wanting MCP tools inside a routine should use an `agent`
 * step with the prompt asking the LLM to call the tool. The agent step has
 * the LLM-mediated path; this stub fails fast with a clear pointer.
 *
 * Why ship the stub anyway: the schema and types accept `mcp` step specs, so
 * the V1.5 inbox-triager spec (per V1 plan §4.4) can be drafted and saved
 * today; only execution is deferred. When V1.5 lands, every existing mcp
 * step starts working without a spec migration.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import i18n from "../../i18n.ts";
import type { StepResult } from "../types.ts";

export async function executeMcpStep(
	step: Extract<RoutineStep, { type: "mcp" }>,
	_context: unknown,
	_signal: AbortSignal,
): Promise<StepResult> {
	return {
		status: "failed",
		stdoutExcerpt: "",
		stderrExcerpt: "",
		error: i18n.t(
			"mcp step is V1.5 (not yet implemented in V1). Requested: server='{{server}}', tool='{{tool}}'. " +
				"Workaround: use an 'agent' step with mcp_servers_allowed: ['{{server}}'] and ask the LLM to call {{tool}}.",
			{ server: step.server, tool: step.tool },
		),
		durationMs: 0,
	};
}
