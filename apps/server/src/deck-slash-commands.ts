import type { SlashCommand, Task } from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import i18n from "./i18n.ts";
import {
	createTask,
	findStateByName,
	findTaskByDisplayOrId,
	getState,
	listStates,
	listTasks,
	moveTask,
} from "./db/tasks.ts";

/**
 * Deck-native slash command. Unlike SDK builtins these operate directly on
 * the deck's own DB and do not need an AgentSession. The dispatcher passes
 * `cwd` so commands can scope writes to the active workspace.
 */
export interface DeckSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	handle(args: string, ctx: DeckSlashContext): Promise<DeckSlashResult> | DeckSlashResult;
}

export interface DeckSlashContext {
	cwd: string;
}

export type DeckSlashResult = { kind: "consumed"; output: string };

function fmtTask(t: Task): string {
	const state = getState(t.stateId);
	return state
		? i18n.t("T-{{id}}: {{title}} ({{state}})", { id: t.displayId, title: t.title, state: state.name })
		: i18n.t("T-{{id}}: {{title}}", { id: t.displayId, title: t.title });
}

function broadcastTasksChanged(): void {
	broadcastBus.broadcast({ type: "tasks_changed" });
}

export const DECK_SLASH_COMMANDS: DeckSlashCommand[] = [
	{
		name: "task add",
		description: i18n.t("Create a backlog task in this workspace"),
		argumentHint: "<title>",
		handle(args, ctx) {
			const title = args.trim();
			if (!title) throw new Error(i18n.t("Usage: /task add <title>"));
			const created = createTask({ title, stateId: "s_backlog", cwd: ctx.cwd });
			broadcastTasksChanged();
			return {
				kind: "consumed",
				output: i18n.t("Created T-{{id}}: {{title}} (backlog)", {
					id: created.displayId,
					title: created.title,
				}),
			};
		},
	},
	{
		name: "task list",
		description: i18n.t("List active and backlog tasks (filter by state name)"),
		argumentHint: "[state]",
		handle(args, ctx) {
			const trimmed = args.trim();
			const states = listStates();
			const targetState = trimmed ? findStateByName(trimmed) : undefined;
			if (trimmed && !targetState) {
				throw new Error(
					i18n.t("No state matches \"{{ref}}\". Known: {{known}}", {
						ref: trimmed,
						known: states.map((s) => s.name).join(", "),
					}),
				);
			}
			const all = listTasks({});
			const scoped = all.filter((t) => t.cwd === undefined || t.cwd === ctx.cwd);
			const visibleStates = targetState ? [targetState] : states.filter((s) => s.name === "active" || s.name === "backlog");
			const lines: string[] = [];
			for (const state of visibleStates) {
				const items = scoped.filter((t) => t.stateId === state.id);
				if (items.length === 0) continue;
				lines.push(`${state.name.toUpperCase()}`);
				for (const t of items) lines.push(`  T-${t.displayId}  ${t.title}`);
			}
			if (lines.length === 0) {
				return { kind: "consumed", output: i18n.t("No tasks.") };
			}
			return { kind: "consumed", output: lines.join("\n") };
		},
	},
	{
		name: "task done",
		description: i18n.t("Move a task to the done column"),
		argumentHint: "<T-id|ULID>",
		handle(args) {
			const ref = args.trim();
			if (!ref) throw new Error(i18n.t("Usage: /task done <T-id|ULID>"));
			const existing = findTaskByDisplayOrId(ref);
			if (!existing) throw new Error(i18n.t("No task matches \"{{ref}}\".", { ref }));
			const target = findStateByName("done");
			if (!target) throw new Error(i18n.t("No `done` state configured."));
			const fromState = getState(existing.stateId);
			const moved = moveTask(existing.id, target.id, Number.POSITIVE_INFINITY);
			if (!moved) throw new Error(i18n.t("Task {{ref}} disappeared.", { ref }));
			broadcastTasksChanged();
			return {
				kind: "consumed",
				output: i18n.t("T-{{id}}: {{from}} → done", { id: moved.displayId, from: fromState?.name ?? "?" }),
			};
		},
	},
	{
		name: "task move",
		description: i18n.t("Move a task to a different column"),
		argumentHint: "<T-id|ULID> <state>",
		handle(args) {
			const trimmed = args.trim();
			const m = /^(\S+)\s+(.+)$/.exec(trimmed);
			if (!m) throw new Error(i18n.t("Usage: /task move <T-id|ULID> <state>"));
			const [, ref, stateName] = m;
			const existing = findTaskByDisplayOrId(ref!);
			if (!existing) throw new Error(i18n.t("No task matches \"{{ref}}\".", { ref }));
			const target = findStateByName(stateName!);
			if (!target) {
				const names = listStates().map((s) => s.name).join(", ");
				throw new Error(i18n.t("No state matches \"{{ref}}\". Known: {{known}}", { ref: stateName, known: names }));
			}
			const fromState = getState(existing.stateId);
			const moved = moveTask(existing.id, target.id, Number.POSITIVE_INFINITY);
			if (!moved) throw new Error(i18n.t("Task {{ref}} disappeared.", { ref }));
			broadcastTasksChanged();
			return {
				kind: "consumed",
				output: i18n.t("T-{{id}}: {{from}} → {{to}}", {
					id: moved.displayId,
					from: fromState?.name ?? "?",
					to: target.name,
				}),
			};
		},
	},
	{
		name: "prompts-recommend",
		description: "Open the prompt-recommendation panel for this session's cwd.",
		handle() {
			// Suggestions render via <PromptSuggestions /> in the composer
			// (see apps/web/src/components/PromptSuggestions.tsx). The deck
			// slash dispatcher echoes the synthetic round-trip output so
			// chat-side consumers see a friendly line; the panel itself
			// is driven by the composer's idle-5s heuristic and the
			// /api/prompts/recommend HTTP endpoint.
			return { kind: "consumed" as const, output: "Prompt suggestions panel — see composer." };
		},
	},
];


/**
 * Parse the leading slash command from `text` and dispatch via the registry.
 * Matching is whitespace-tolerant: `/task add foo bar` walks the registry
 * looking for the longest prefix match, then passes the remainder as `args`.
 */
export async function executeDeckSlashCommand(
	text: string,
	ctx: DeckSlashContext,
): Promise<DeckSlashResult | "fallthrough"> {
	if (!text.startsWith("/")) return "fallthrough";
	const body = text.slice(1);
	// Find the longest registered name that prefixes `body` with either EOL or whitespace.
	let match: DeckSlashCommand | undefined;
	let argStart = 0;
	for (const cmd of DECK_SLASH_COMMANDS) {
		if (body === cmd.name) {
			if (!match || cmd.name.length > match.name.length) {
				match = cmd;
				argStart = body.length;
			}
		} else if (body.startsWith(`${cmd.name} `) || body.startsWith(`${cmd.name}\n`)) {
			if (!match || cmd.name.length > match.name.length) {
				match = cmd;
				argStart = cmd.name.length;
			}
		}
	}
	if (!match) return "fallthrough";
	const args = body.slice(argStart).trimStart();
	return await match.handle(args, ctx);
}

/** Project the registry into protocol `SlashCommand` rows for the picker. */
export function deckSlashCommandEntries(): SlashCommand[] {
	return DECK_SLASH_COMMANDS.map((c) => {
		const out: SlashCommand = {
			name: c.name,
			scope: "deck",
			description: c.description,
		};
		if (c.argumentHint) out.argumentHint = c.argumentHint;
		return out;
	});
}

