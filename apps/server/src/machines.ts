/**
 * Remote agent-host registry (multi-machine).
 *
 * The registry is a JSON file (`OMP_DECK_MACHINES_FILE`, default
 * `<dataDir>/machines.json`) listing every remote omp agent host the center
 * may connect to. Entries are read at boot and mutated through the
 * `/api/machines` REST surface — CRUD writes the file back immediately and
 * takes effect on the next request (each HostClient connects on demand, so
 * no restart is needed for additions; edits to baseUrl/token apply to the
 * next connection).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { logger } from "./log.ts";
import { getDataDir } from "./env-store.ts";

const log = logger("machines");

export interface MachineEntry {
	id: string;
	name: string;
	baseUrl: string;
	token: string;
	defaultCwd?: string;
}

export interface MachineRegistry {
	list(): MachineEntry[];
	get(id: string): MachineEntry | undefined;
	add(entry: MachineEntry): void;
	update(id: string, patch: Partial<MachineEntry>): MachineEntry | undefined;
	remove(id: string): boolean;
}

function machinesFilePath(): string {
	const explicit = process.env.OMP_DECK_MACHINES_FILE?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(getDataDir(), "machines.json");
}

/**
 * @param existing Registry map for uniqueness checks.
 * @param selfId When set (update path), the entry's own id is exempt from the
 *        uniqueness check — an update must not reject itself.
 */
function validateEntry(
	entry: MachineEntry,
	existing: Map<string, MachineEntry>,
	selfId?: string,
): string | undefined {
	if (!entry.id || !/^[A-Za-z0-9_-]+$/.test(entry.id)) return "id must be non-empty [A-Za-z0-9_-]+";
	if (selfId !== entry.id && existing.has(entry.id)) return `machine id already exists: ${entry.id}`;
	if (!entry.name || entry.name.trim().length === 0) return "name is required";
	if (!/^https?:\/\//.test(entry.baseUrl)) return "baseUrl must start with http:// or https://";
	if (!entry.token || entry.token.trim().length === 0) return "token is required";
	return undefined;
}

export function loadMachines(): MachineRegistry {
	const file = machinesFilePath();
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		raw = [];
	}
	let entries: MachineEntry[] = [];
	if (Array.isArray(raw)) {
		entries = raw.filter(isMachineEntry);
	} else {
		log.warn(`machines file ${file} is not an array; treating as empty`);
	}
	const byId = new Map(entries.map((e) => [e.id, e]));
	const list = () => [...byId.values()];

	function persist(): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(list(), null, 2));
		fs.renameSync(tmp, file);
	}

	return {
		list,
		get: (id) => byId.get(id),
		add(entry) {
			const err = validateEntry(entry, byId);
			if (err) throw new Error(err);
			byId.set(entry.id, { ...entry });
			persist();
		},
		update(id, patch) {
			const current = byId.get(id);
			if (!current) return undefined;
			const next: MachineEntry = { ...current, ...patch };
			const err = validateEntry(next, byId, id);
			if (err) throw new Error(err);
			byId.set(id, next);
			persist();
			return { ...next };
		},
		remove(id) {
			const removed = byId.delete(id);
			if (removed) persist();
			return removed;
		},
	};
}

function isMachineEntry(value: unknown): value is MachineEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.name === "string" &&
		typeof v.baseUrl === "string" &&
		typeof v.token === "string" &&
		(v.defaultCwd === undefined || typeof v.defaultCwd === "string")
	);
}
