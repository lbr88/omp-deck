import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, Play, QrCode as QrIcon, RotateCcw, Save, Square, X } from "lucide-react";
import type {
	BridgeInfo,
	BridgeName,
	EnvEntry,
	GateKnob,
	ListEnvSettingsResponse,
	MachineInfo,
	MaintenanceGateState,
	NotificationLevel,
	PreludeResponse,
	StartCommand,
} from "@omp-deck/protocol";
import type { ProviderInfo } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { OAuthFlowModal } from "@/components/settings/OAuthFlowModal";
import { bridgesApi } from "@/lib/bridges-api";
import { machinesApi } from "@/lib/machines-api";
import { settingsApi } from "@/lib/settings-api";
import { orientationApi } from "@/lib/orientation-api";
import { authApi } from "@/lib/auth-api";
import { type AuthError, type AuthStatus, deckAuthApi } from "@/lib/deck-auth-api";
import { attachApi, type AttachHistoryEntry } from "@/lib/attach-api";
import { SessionAttachQR } from "@/components/SessionAttachQR";
import { RichEditor } from "@/components/RichEditor";
import { CopyButton } from "@/lib/CopyButton";
import { playNotificationTone } from "@/lib/audio";
import { useNotificationPermission } from "@/lib/notifications";
import { useInstallPrompt, usePushSubscription } from "@/lib/pwa";
import { useStore, type NotificationItem } from "@/lib/store";
import { THEMES, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import i18n, { SUPPORTED_LANGS, getStoredLang, setLang } from "@/i18n";

const SECTIONS = [
	{ id: "account", label: "Account", description: "Your sign-in, password and devices" },
	{ id: "remote-access", label: "Remote Access", description: "How your phone reaches this deck" },
	{ id: "env", label: "Env", description: "Process and deck-managed variables" },
	{ id: "access", label: "Access", description: "API access token" },
	{ id: "machines", label: "Machines", description: "Remote omp agent hosts" },
	{ id: "providers", label: "Providers", description: "OAuth sign-in and API-key state" },
	{ id: "messaging", label: "Messaging", description: "Telegram and future chat bridges" },
	{ id: "orientation", label: "Orientation", description: "Prelude, /start, maintenance gate" },
	{ id: "appearance", label: "Appearance", description: "Themes, colors, fonts" },
	{ id: "workspaces", label: "Workspaces", description: "Pinned roots and display names" },
	{ id: "notifications", label: "Notifications", description: "Idle alerts and quiet hours" },
	{ id: "about", label: "About", description: "Version, paths, diagnostics" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsView() {
	const { t } = useTranslation();
	const [params, setParams] = useSearchParams();
	const selected = normalizeSection(params.get("section"));

	function setSection(section: SectionId): void {
		const next = new URLSearchParams(params);
		next.set("section", section);
		setParams(next, { replace: true });
	}

	return (
		<Layout
			sidebar={<SettingsSideRail />}
			inspector={<SettingsInspector />}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">{t("Settings")}</div>
						<div className="text-xs text-ink-3">{t("Configure this local deck instance")}</div>
					</div>
					<div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] overflow-hidden">
						<nav className="border-r border-line bg-paper-2/40 p-2">
							{SECTIONS.map((section) => (
								<button
									key={section.id}
									type="button"
									onClick={() => setSection(section.id)}
									className={cn(
										"mb-1 block w-full rounded-md px-2 py-2 text-left transition-colors",
										selected === section.id ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="font-mono text-xs font-medium uppercase tracking-meta">
										{t(section.label)}
									</div>
									<div className="mt-0.5 text-xs text-ink-3">{t(section.description)}</div>
								</button>
							))}
						</nav>
						<section className="min-h-0 overflow-auto p-4">
							{selected === "account" ? (
								<AccountSection />
							) : selected === "remote-access" ? (
								<RemoteAccessSection />
							) : selected === "env" ? (
								<EnvSection />
							) : selected === "access" ? (
								<AccessSection />
							) : selected === "machines" ? (
								<MachinesSection />
							) : selected === "providers" ? (
								<ProvidersSection />
							) : selected === "messaging" ? (
								<MessagingSection />
							) : selected === "orientation" ? (
								<OrientationSection />
							) : selected === "appearance" ? (
								<AppearanceSection />
							) : selected === "notifications" ? (
								<NotificationsSection />
							) : (
								<StubSection section={selected} />
							)}
						</section>
					</div>
				</div>
			}
		/>
	);
}

/** Env-fetching client — local settingsApi or a remote machine proxy. */
interface EnvClient {
	listEnv(): Promise<ListEnvSettingsResponse>;
	patchEnv(updates: Record<string, string | null>): Promise<ListEnvSettingsResponse>;
	restart?(): Promise<{ ok: boolean; message?: string }>;
}

/**
 * Generic env browser over an {@link EnvClient}. The local Env section and
 * the Machines section's per-machine env views share this; the only
 * difference is which client backs it.
 */
function EnvBrowser({
	heading,
	client,
	fileInfo,
	group,
}: {
	heading: string;
	client: EnvClient;
	fileInfo?: boolean;
	group?: boolean;
}) {
	const { t } = useTranslation();
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);
	const [restartMessage, setRestartMessage] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await client.listEnv();
			setData(next);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const grouped = useMemo(() => {
		const entries = data?.entries ?? [];
		const isDeckKey = (key: string) =>
			key.startsWith("OMP_DECK_") ||
			key === "OMP_AGENT_DIR" ||
			key === "LOG_LEVEL" ||
			key === "PI_NO_TITLE" ||
			key === "OMP_MODEL";
		const isMessagingKey = (key: string) => key.startsWith("TELEGRAM_") || key.startsWith("SLACK_");
		return {
			deck: entries.filter((e) => isDeckKey(e.key)),
			messaging: entries.filter((e) => isMessagingKey(e.key)),
			sdk: entries.filter((e) => !isDeckKey(e.key) && !isMessagingKey(e.key)),
		};
	}, [data]);

	async function restart(): Promise<void> {
		if (!client.restart) return;
		try {
			const resp = await client.restart();
			setRestartMessage(resp.message || t("Restart scheduled"));
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
				{group ? (
					<p className="mt-1 max-w-3xl text-sm text-ink-3">
						{t(
							"Edits write to the deck-managed env file only. Variables from the launching process stay higher priority until you remove them from that shell/profile.",
						)}
					</p>
				) : null}
			</div>

			{data?.restartRequired && client.restart ? (
				<div className="flex items-center gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
					<div className="min-w-0 flex-1">
						{t("Restart server to apply one or more restart-required values from the managed .env.")}
					</div>
					<Button variant="outline" size="sm" onClick={() => void restart()}>
						<RotateCcw className="h-3.5 w-3.5" />
						{t("Restart")}
					</Button>
				</div>
			) : null}
			{restartMessage ? (
				<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
					{restartMessage}
				</div>
			) : null}
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			{fileInfo ? (
				<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
					<div>dataDir: {data?.dataDir ?? "..."}</div>
					<div>envFile: {data?.envFilePath ?? "..."}</div>
				</div>
			) : null}

			{loading ? <div className="text-sm text-ink-3">{t("Loading...")}</div> : null}
			{data ? (
				<>
					{group ? (
						<>
							<EnvTable title={t("omp-deck")} entries={grouped.deck} onEdit={setEditing} />
							<EnvTable title={t("messaging bridges")} entries={grouped.messaging} onEdit={setEditing} />
							<EnvTable title={t("omp SDK / providers")} entries={grouped.sdk} onEdit={setEditing} />
						</>
					) : (
						<EnvTable title={t("host env")} entries={data.entries} onEdit={setEditing} />
					)}
				</>
			) : null}

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				patch={client.patchEnv}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
				}}
			/>
		</div>
	);
}

function EnvSection() {
	const { t } = useTranslation();
	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<EnvBrowser
				heading={t("Environment variables")}
				client={{
					listEnv: settingsApi.listEnv,
					patchEnv: settingsApi.patchEnv,
					restart: async () => settingsApi.restartServer(),
				}}
				fileInfo
				group
			/>
		</div>
	);
}

/**
 * Session status for the deck's access-token login. The token itself never
 * reaches this browser — login happens on the full-screen gate (first visit
 * or after a 401) and the server holds an HttpOnly session cookie. Here the
 * user can see the session state and sign out.
 */
function AccessSection() {
	const { t } = useTranslation();
	const unauthorized = useStore((s) => s.unauthorized);
	const logout = useStore((s) => s.logout);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function signOut(): Promise<void> {
		setBusy(true);
		setError(undefined);
		try {
			await logout();
		} catch (err) {
			setError(String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto max-w-2xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Access")}</h1>
				<p className="mt-1 max-w-xl text-sm text-ink-3">
					{t(
						"When the server runs with OMP_DECK_ACCESS_TOKEN set, this browser signs in with the token once — the server verifies it and issues an HttpOnly session cookie. The token is never stored in the browser.",
					)}
				</p>
			</div>

			<div className="rounded-md border border-line bg-paper p-4">
				<div className="flex items-center gap-2">
					<Badge tone={unauthorized ? "danger" : "success"}>
						{unauthorized ? t("signed out") : t("signed in")}
					</Badge>
					<span className="font-mono text-2xs text-ink-4">
						{unauthorized
							? t("The login screen will ask for the token on your next visit.")
							: t("session cookie active; token not readable from this page")}
					</span>
				</div>
				{error ? (
					<div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				<div className="mt-3">
					<Button variant="danger" size="sm" disabled={busy || unauthorized} onClick={() => void signOut()}>
						{t("Sign out")}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * Remote agent-host registry: list/add/edit/remove machines, probe live
 * status, and open each machine's env browser (proxy of /host/env).
 */
function MachinesSection() {
	const { t } = useTranslation();
	const [machines, setMachines] = useState<MachineInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [envMachineId, setEnvMachineId] = useState<string | null>(null);
	const [editing, setEditing] = useState<MachineInfo | null>(null);
	const [adding, setAdding] = useState(false);

	async function refresh(): Promise<void> {
		try {
			const resp = await machinesApi.list();
			setMachines(resp.machines);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function removeMachine(id: string): Promise<void> {
		if (!confirm(t('Remove machine "{{id}}"?', { id }))) return;
		try {
			await machinesApi.remove(id);
			setMachines((prev) => prev.filter((m) => m.id !== id));
		} catch (e) {
			setError(String(e));
		}
	}

	if (envMachineId) {
		const machine = machines.find((m) => m.id === envMachineId);
		return (
			<div className="mx-auto max-w-6xl space-y-4">
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => setEnvMachineId(null)}>
						← {t("Machines")}
					</Button>
					<h1 className="text-lg font-semibold tracking-tight">
						{t("Environment — {{machine}}", { machine: machine?.name ?? envMachineId })}
					</h1>
				</div>
				<EnvBrowser
					heading=""
					client={{
						listEnv: () => machinesApi.env(envMachineId),
						patchEnv: (updates) => machinesApi.patchEnv(envMachineId, updates),
					}}
				/>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Machines")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t(
						"Remote omp agent hosts running the omp-agent-host extension. Sessions created on a machine run there; kanban tasks can be assigned to a machine.",
					)}
				</p>
			</div>

			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			{loading ? <div className="text-sm text-ink-3">{t("Loading...")}</div> : null}

			<div className="space-y-2">
				{machines.map((m) => (
					<div
						key={m.id}
						className="flex items-center gap-3 rounded-md border border-line bg-paper px-3 py-2.5 text-sm"
					>
						<span
							className={`h-2 w-2 shrink-0 rounded-full ${m.online ? "bg-success" : "bg-danger"}`}
							title={m.online ? t("online") : t("offline")}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-2">
								<span className="truncate font-medium text-ink">{m.name}</span>
								<span className="font-mono text-2xs text-ink-4">{m.id}</span>
								{m.defaultCwd ? (
									<span className="truncate font-mono text-2xs text-ink-3">{m.defaultCwd}</span>
								) : null}
							</div>
							<div className="truncate font-mono text-2xs text-ink-3">
								{m.baseUrl} · {m.online ? t("online") : t("offline")}
								{m.modelCount !== undefined ? ` · ${m.modelCount} ${t("models")}` : ""}
								{m.sessionCount !== undefined ? ` · ${m.sessionCount} ${t("sessions")}` : ""}
							</div>
						</div>
						<div className="flex shrink-0 gap-1.5">
							<Button variant="outline" size="sm" onClick={() => setEnvMachineId(m.id)}>
								{t("Env")}
							</Button>
							<Button variant="outline" size="sm" onClick={() => setEditing(m)}>
								{t("Edit")}
							</Button>
							<Button variant="danger" size="sm" onClick={() => void removeMachine(m.id)}>
								{t("Remove")}
							</Button>
						</div>
					</div>
				))}
				{machines.length === 0 && !loading ? (
					<div className="rounded-md border border-dashed border-line-strong px-3 py-6 text-center font-mono text-2xs text-ink-3">
						{t("No machines registered. Add the first one below.")}
					</div>
				) : null}
			</div>

			<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
				+ {t("Add machine")}
			</Button>

			<MachineEditModal
				machine={editing}
				open={editing !== null}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setMachines((prev) => prev.map((m) => (m.id === next.id ? { ...m, ...next } : m)));
					setEditing(null);
					void refresh();
				}}
			/>
			<MachineAddModal
				open={adding}
				onClose={() => setAdding(false)}
				onAdded={() => {
					setAdding(false);
					void refresh();
				}}
			/>
		</div>
	);
}

function MachineEditModal({
	machine,
	open,
	onClose,
	onSaved,
}: {
	machine: MachineInfo | null;
	open: boolean;
	onClose: () => void;
	onSaved: (next: { id: string; name: string; baseUrl: string; defaultCwd?: string }) => void;
}) {
	const { t } = useTranslation();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [token, setToken] = useState("");
	const [defaultCwd, setDefaultCwd] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!machine) return;
		setName(machine.name);
		setBaseUrl(machine.baseUrl);
		setToken(""); // never prefill secrets
		setDefaultCwd(machine.defaultCwd ?? "");
		setError(undefined);
	}, [machine]);

	if (!open || !machine) return null;
	const machineId = machine.id;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			await machinesApi.update(machineId, {
				name,
				baseUrl,
				...(token.trim() ? { token: token.trim() } : {}),
				// Always send defaultCwd so clearing the field removes it.
				defaultCwd: defaultCwd.trim(),
			});
			onSaved({ id: machineId, name, baseUrl, defaultCwd: defaultCwd.trim() || undefined });
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-lg">
			<MachineForm
				title={t("Edit machine")}
				idReadOnly={machine.id}
				name={name}
				setName={setName}
				baseUrl={baseUrl}
				setBaseUrl={setBaseUrl}
				token={token}
				setToken={setToken}
				defaultCwd={defaultCwd}
				setDefaultCwd={setDefaultCwd}
				error={error}
				saving={saving}
				onSave={() => void save()}
				onClose={onClose}
			/>
		</Modal>
	);
}

function MachineAddModal({
	open,
	onClose,
	onAdded,
}: {
	open: boolean;
	onClose: () => void;
	onAdded: () => void;
}) {
	const { t } = useTranslation();
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [token, setToken] = useState("");
	const [defaultCwd, setDefaultCwd] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function save(): Promise<void> {
		setSaving(true);
		try {
			await machinesApi.register({
				id: id.trim(),
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				token: token.trim(),
				...(defaultCwd.trim() ? { defaultCwd: defaultCwd.trim() } : {}),
			});
			setId("");
			setName("");
			setBaseUrl("");
			setToken("");
			setDefaultCwd("");
			onAdded();
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-lg">
			<MachineForm
				title={t("Add machine")}
				id={id}
				setId={setId}
				name={name}
				setName={setName}
				baseUrl={baseUrl}
				setBaseUrl={setBaseUrl}
				token={token}
				setToken={setToken}
				defaultCwd={defaultCwd}
				setDefaultCwd={setDefaultCwd}
				error={error}
				saving={saving}
				onSave={() => void save()}
				onClose={onClose}
			/>
		</Modal>
	);
}

function MachineForm({
	title,
	id,
	setId,
	idReadOnly,
	name,
	setName,
	baseUrl,
	setBaseUrl,
	token,
	setToken,
	defaultCwd,
	setDefaultCwd,
	error,
	saving,
	onSave,
	onClose,
}: {
	title: string;
	id?: string;
	setId?: (v: string) => void;
	idReadOnly?: string;
	name: string;
	setName: (v: string) => void;
	baseUrl: string;
	setBaseUrl: (v: string) => void;
	token: string;
	setToken: (v: string) => void;
	defaultCwd: string;
	setDefaultCwd: (v: string) => void;
	error?: string;
	saving: boolean;
	onSave: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="p-4">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-base font-semibold text-ink">{title}</h2>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label={t("Close")}>
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3">
				{idReadOnly ? (
					<div className="flex items-center gap-2 font-mono text-xs">
						<span className="text-ink-4">{t("id")}</span>
						<span className="text-ink">{idReadOnly}</span>
					</div>
				) : (
					<label className="block">
						<div className="meta mb-1">{t("id")}</div>
						<input
							className="field h-9 w-full px-2 font-mono text-sm"
							value={id ?? ""}
							onChange={(e) => setId?.(e.target.value)}
							placeholder="lab"
						/>
					</label>
				)}
				<label className="block">
					<div className="meta mb-1">{t("name")}</div>
					<input
						className="field h-9 w-full px-2 text-sm"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t("My lab machine")}
					/>
				</label>
				<label className="block">
					<div className="meta mb-1">{t("base URL")}</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						placeholder="http://100.64.0.2:8790"
					/>
				</label>
				<label className="block">
					<div className="meta mb-1">{t("token")}</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder={t("OMP_AGENT_HOST_TOKEN on the machine")}
					/>
				</label>
				<label className="block">
					<div className="meta mb-1">{t("default cwd (optional)")}</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						value={defaultCwd}
						onChange={(e) => setDefaultCwd(e.target.value)}
						placeholder="/home/user/projects"
					/>
				</label>
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				<div className="flex justify-end gap-2 pt-1">
					<Button variant="ghost" size="sm" onClick={onClose}>
						{t("Cancel")}
					</Button>
					<Button size="sm" disabled={saving} onClick={onSave}>
						{t("Save")}
					</Button>
				</div>
			</div>
		</div>
	);
}

function MessagingSection() {
	const { t } = useTranslation();
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [bridges, setBridges] = useState<BridgeInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);

	async function refresh(): Promise<void> {
		try {
			const [envResp, bridgeResp] = await Promise.all([settingsApi.listEnv(), bridgesApi.list()]);
			setData(envResp);
			setBridges(bridgeResp.bridges);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 4000);
		return () => window.clearInterval(id);
	}, []);

	const entries = data?.entries ?? [];
	const telegramToken = entries.find((entry) => entry.key === "TELEGRAM_BOT_TOKEN");
	const telegramAllowed = entries.find((entry) => entry.key === "TELEGRAM_ALLOWED_USERS");
	const telegramDb = entries.find((entry) => entry.key === "TELEGRAM_BRIDGE_DB_PATH");
	const telegramInfo = bridges.find((b) => b.name === "telegram");

	function applyBridge(next: BridgeInfo): void {
		setBridges((prev) => {
			const idx = prev.findIndex((b) => b.name === next.name);
			if (idx === -1) return [...prev, next];
			const out = prev.slice();
			out[idx] = next;
			return out;
		});
	}

	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Messaging bridges")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t(
						"Save credentials, then start the bridge. The deck supervises the process; saving a token alone does not bring the integration online.",
					)}
				</p>
			</div>

			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			{loading ? <div className="text-sm text-ink-3">{t("Loading...")}</div> : null}

			<BridgeCard
				title={t("Telegram")}
				description={t("DM-only long-poll bridge to local omp-deck.")}
				info={telegramInfo}
				credentialRows={[
					{ label: t("Bot token"), entry: telegramToken },
					{ label: t("Allowed users"), entry: telegramAllowed },
					{ label: t("Mapping DB path"), entry: telegramDb },
				]}
				onEdit={setEditing}
				onApplyBridge={applyBridge}
				onError={setError}
			/>

			<div className="rounded-md border border-dashed border-line bg-paper-2 p-4">
				<div className="meta">Slack</div>
				<p className="mt-1 text-sm text-ink-3">
					{t(
						"Reserved for the same pattern: product-level setup here, shared managed-env storage underneath.",
					)}
				</p>
			</div>

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				patch={settingsApi.patchEnv}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
					void refresh();
				}}
			/>
		</div>
	);
}

function BridgeCard({
	title,
	description,
	info,
	credentialRows,
	onEdit,
	onApplyBridge,
	onError,
}: {
	title: string;
	description: string;
	info: BridgeInfo | undefined;
	credentialRows: Array<{ label: string; entry: EnvEntry | undefined }>;
	onEdit: (entry: EnvEntry) => void;
	onApplyBridge: (next: BridgeInfo) => void;
	onError: (message: string | undefined) => void;
}) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState<"start" | "stop" | "restart" | undefined>();

	async function run(action: "start" | "stop" | "restart", name: BridgeName): Promise<void> {
		setBusy(action);
		onError(undefined);
		try {
			const next = await bridgesApi[action](name);
			onApplyBridge(next);
		} catch (e) {
			onError(String((e as Error).message ?? e));
		} finally {
			setBusy(undefined);
		}
	}

	const status = info?.status ?? "stopped";
	const missing = info?.missingEnv ?? [];
	const canStart = status !== "running" && status !== "starting" && missing.length === 0;
	const canStop = status === "running" || status === "starting";
	const canRestart = status === "running";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="flex items-center justify-between gap-3 border-b border-line bg-paper-2 px-3 py-2">
				<div>
					<div className="meta">{title}</div>
					<div className="mt-0.5 text-xs text-ink-3">{description}</div>
				</div>
				<div className="flex items-center gap-2">
					<Badge tone={bridgeStatusTone(status)}>{bridgeStatusLabel(status, info)}</Badge>
				</div>
			</div>
			<div className="space-y-3 p-3">
				{missing.length > 0 ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						{t("Missing required env: {{envs}}. Set these below before starting the bridge.", {
							envs: <span className="font-mono">{missing.join(", ")}</span>,
						})}
					</div>
				) : null}
				{info?.lastError ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{info.lastError}
					</div>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={!canStart || busy !== undefined}
						onClick={() => info && void run("start", info.name)}
					>
						<Play className="h-3.5 w-3.5" />
						{busy === "start" ? t("Starting...") : t("Start")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canStop || busy !== undefined}
						onClick={() => info && void run("stop", info.name)}
					>
						<Square className="h-3.5 w-3.5" />
						{busy === "stop" ? t("Stopping...") : t("Stop")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canRestart || busy !== undefined}
						onClick={() => info && void run("restart", info.name)}
					>
						<RotateCcw className="h-3.5 w-3.5" />
						{busy === "restart" ? t("Restarting...") : t("Restart")}
					</Button>
					{info ? <BridgeMeta info={info} /> : null}
				</div>
				<div className="divide-y divide-line rounded-md border border-line">
					{credentialRows.map((row) => (
						<MessagingCredentialRow key={row.label} label={row.label} entry={row.entry} onEdit={onEdit} />
					))}
				</div>
				{info ? <BridgeLogsPanel name={info.name} /> : null}
			</div>
		</div>
	);
}

function BridgeMeta({ info }: { info: BridgeInfo }) {
	const { t } = useTranslation();
	const parts: string[] = [];
	if (info.status === "running") {
		if (info.pid !== undefined) parts.push(t("pid {{pid}}", { pid: info.pid }));
		if (info.startedAt) parts.push(t("up {{uptime}}", { uptime: formatUptime(info.startedAt) }));
	} else if (info.exitCode !== undefined) {
		parts.push(t("exit {{code}}", { code: info.exitCode }));
	}
	if (info.crashCount > 0) parts.push(t("crashes {{count}}", { count: info.crashCount }));
	if (parts.length === 0) return null;
	return <div className="font-mono text-2xs text-ink-3">{parts.join(" · ")}</div>;
}

function BridgeLogsPanel({ name }: { name: BridgeName }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [lines, setLines] = useState<Array<{ stream: string; text: string; timestamp: string }>>([]);
	const [fetching, setFetching] = useState(false);

	async function load(): Promise<void> {
		setFetching(true);
		try {
			const resp = await bridgesApi.logs(name);
			setLines(resp.lines);
		} catch (e) {
			setLines([{ stream: "stderr", text: String(e), timestamp: new Date().toISOString() }]);
		} finally {
			setFetching(false);
		}
	}

	useEffect(() => {
		if (!open) return;
		void load();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 2500);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, name]);

	return (
		<div className="rounded-md border border-line bg-paper-2">
			<button
				type="button"
				className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-ink-2 hover:bg-paper-3"
				onClick={() => setOpen((v) => !v)}
			>
				<span>{t("Bridge logs")}</span>
				<span className="font-mono text-2xs text-ink-3">{open ? t("hide") : t("show")}</span>
			</button>
			{open ? (
				<div className="max-h-64 overflow-auto border-t border-line bg-paper p-2 font-mono text-2xs">
					{fetching && lines.length === 0 ? <div className="text-ink-3">{t("Loading...")}</div> : null}
					{!fetching && lines.length === 0 ? <div className="text-ink-3">{t("No log lines yet.")}</div> : null}
					{lines.map((line, idx) => (
						<div
							key={`${line.timestamp}-${idx}`}
							className={cn("whitespace-pre-wrap", line.stream === "stderr" ? "text-danger" : "text-ink-2")}
						>
							{line.text}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function MessagingCredentialRow({
	label,
	entry,
	onEdit,
}: {
	label: string;
	entry: EnvEntry | undefined;
	onEdit: (entry: EnvEntry) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="grid grid-cols-[160px_1fr_120px] items-center gap-3 px-3 py-2 text-sm">
			<div>
				<div className="font-medium text-ink">{label}</div>
				<div className="font-mono text-2xs text-ink-4">{entry?.key ?? t("missing schema")}</div>
			</div>
			<div className="min-w-0">
				<div className="truncate font-mono text-xs text-ink-2">{entry?.masked ?? t("unavailable")}</div>
				<div className="mt-0.5 flex flex-wrap gap-1">
					{entry ? <Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge> : null}
					{entry ? envApplyBadge(entry) : null}
				</div>
			</div>
			<div className="flex justify-end">
				<Button variant="outline" size="sm" disabled={!entry} onClick={() => entry && onEdit(entry)}>
					{t("Replace")}
				</Button>
			</div>
		</div>
	);
}

function EnvTable({
	title,
	entries,
	onEdit,
}: {
	title: string;
	entries: EnvEntry[];
	onEdit: (entry: EnvEntry) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">{title}</div>
			</div>
			<div className="divide-y divide-line">
				{entries.map((entry) => (
					<div key={entry.key} className="grid grid-cols-[220px_1fr_120px_100px] gap-3 px-3 py-2 text-sm">
						<div className="min-w-0">
							<div className="truncate font-mono text-xs font-medium text-ink">{entry.key}</div>
							<div className="mt-0.5 text-xs text-ink-4">{entry.valueType}</div>
						</div>
						<div className="min-w-0">
							<div className="truncate font-mono text-xs text-ink-2">{entry.masked}</div>
							<div className="mt-0.5 truncate text-xs text-ink-3">{entry.description}</div>
						</div>
						<div className="flex flex-col items-start gap-1">
							<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge>
							{envApplyBadge(entry)}
						</div>
						<div className="flex justify-end">
							<Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
								{t("Replace")}
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function EditEnvModal({
	entry,
	onClose,
	patch,
	onSaved,
}: {
	entry: EnvEntry | null;
	onClose: () => void;
	patch: (updates: Record<string, string | null>) => Promise<ListEnvSettingsResponse>;
	onSaved: (next: ListEnvSettingsResponse) => void;
}) {
	const { t } = useTranslation();
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!entry) return;
		setValue(entry.sensitive ? "" : entry.source === "unset" ? "" : entry.masked);
		setError(undefined);
	}, [entry]);

	if (!entry) return null;

	async function save(nextValue: string | null): Promise<void> {
		if (!entry) return;
		setSaving(true);
		try {
			const next = await patch({ [entry.key]: nextValue });
			onSaved(next);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal open={Boolean(entry)} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-xs font-semibold text-ink">{entry.key}</div>
					<div className="text-xs text-ink-3">{t("Writes to managed .env only")}</div>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label={t("Close")}>
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3 overflow-auto p-4">
				<div className="flex flex-wrap gap-1.5">
					<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge>
					{entry.sensitive ? <Badge tone="danger">{t("secret")}</Badge> : null}
					{entry.restartRequired ? (
						<Badge tone="warn">{t("restart required")}</Badge>
					) : (
						<Badge tone="success">{t("hot apply")}</Badge>
					)}
				</div>
				<p className="text-sm text-ink-3">{entry.description}</p>
				{entry.source === "process-env" ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						{t(
							"This key is currently supplied by the launching process. Replacing it here writes the managed env file, but process env remains higher priority until removed upstream.",
						)}
					</div>
				) : null}
				<label className="block">
					<div className="meta mb-1">{t("New value")}</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						type={entry.sensitive ? "password" : "text"}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={entry.sensitive ? t("Paste replacement value") : entry.defaultValue ?? t("Unset")}
					/>
				</label>
				{entry.options ? (
					<div className="text-xs text-ink-3">{t("Allowed: {{values}}", { values: entry.options.join(", ") })}</div>
				) : null}
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-between gap-2 border-t border-line px-3 py-3">
				<Button variant="danger" size="sm" disabled={saving} onClick={() => void save(null)}>
					{t("Unset")}
				</Button>
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
						{t("Cancel")}
					</Button>
					<Button variant="primary" size="sm" onClick={() => void save(value)} disabled={saving}>
						<Save className="h-3.5 w-3.5" />
						{t("Save")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function AppearanceSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Appearance")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t(
						"Themes swap the entire palette and font stack at runtime. Your choice is stored in this browser; clearing it falls back to the system color preference.",
					)}
				</p>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2 text-sm">
				<div className="min-w-0">
					<div className="meta">{t("Language")}</div>
					<div className="mt-0.5 text-xs text-ink-3">{t("Interface language for this browser.")}</div>
				</div>
				<select
					value={getStoredLang()}
					onChange={(e) => setLang(e.target.value as (typeof SUPPORTED_LANGS)[number])}
					className="rounded-md border border-line bg-paper px-2 py-1 text-sm"
				>
					{SUPPORTED_LANGS.map((l) => (
						<option key={l} value={l}>
							{l === "en" ? "English" : "中文"}
						</option>
					))}
				</select>
			</div>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{THEMES.map((def) => (
					<ThemeCard
						key={def.id}
						definition={def}
						isActive={theme.active === def.id}
						isPinned={theme.stored === def.id}
						onPick={() => theme.set(def.id)}
					/>
				))}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2 text-sm">
				<div className="min-w-0">
					<div className="meta">{t("System preference")}</div>
					<div className="mt-0.5 text-xs text-ink-3">
						{theme.usingSystem
							? t("Following the OS: {{os}}.", { os: theme.systemPreferred })
							: t("Pinned to {{pinned}}. The OS currently prefers {{system}}.", {
									pinned: theme.stored,
									system: theme.systemPreferred,
								})}
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={theme.usingSystem}
					onClick={() => theme.clear()}
				>
					{t("Match system")}
				</Button>
			</div>

			<div className="overflow-hidden rounded-md border border-line bg-paper">
				<div className="border-b border-line bg-paper-2 px-3 py-2">
					<div className="meta">{t("Font preview")}</div>
					<div className="mt-0.5 text-xs text-ink-3">
						{t("Driven by the active theme. v1 ships one font set.")}
					</div>
				</div>
				<div className="space-y-3 p-4">
					<div>
						<div className="meta mb-1">{t("Sans")}</div>
						<div className="font-sans text-base text-ink">
							{t("The agent finished compaction and routed the next prompt back to the original session.")}
						</div>
					</div>
					<div>
						<div className="meta mb-1">{t("Mono")}</div>
						<div className="rounded-md border border-line bg-paper-code px-3 py-2 font-mono text-xs text-ink-2">
							{"const status = await bridgesApi.start(\"telegram\");"}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Notifications settings — surfaces the bits T-85 already plumbed:
 * browser-permission state with a request CTA, audio toggle, per-level tone
 * preview, a way to re-show the dismissed permission banner, server identity
 * pulled from the heartbeat frame, and a tail of the in-app notification log.
 */
function NotificationsSection() {
	const { t } = useTranslation();
	const {
		permission,
		requestPermission,
		audioEnabled,
		setAudioEnabled,
		bannerDismissed,
	} = useNotificationPermission();
	const heartbeat = useStore((s) => s.heartbeat);
	const notifications = useStore((s) => s.notifications);
	const dismissNotification = useStore((s) => s.dismissNotification);

	// Show the freshest notifications first; cap to keep the panel tidy.
	// We don't filter by `dismissed` here on purpose — the user dismissed
	// the toast, not the historical record.
	const recent = useMemo(
		() => notifications.slice().reverse().slice(0, 20),
		[notifications],
	);

	// Heartbeat-age clock so "5s ago" updates without re-receiving a frame.
	// Ticks only while the panel is mounted; cheap.
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(handle);
	}, []);

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Notifications")}</h1>
				<p className="mt-1 text-sm text-ink-3">
					{t(
						"Browser notifications and audio cues for routine failures, agent activity, and other server-emitted events. Settings live in this browser only.",
					)}
				</p>
			</div>

			<MobileAppCard />

			<PermissionCard
				permission={permission}
				onRequest={() => void requestPermission()}
			/>

			<AudioCard
				audioEnabled={audioEnabled}
				onToggle={setAudioEnabled}
			/>

			<BannerResetCard
				bannerDismissed={bannerDismissed}
				permission={permission}
				onReset={() => {
					try {
						localStorage.removeItem("omp-deck:notifications:banner-dismissed");
					} catch {
						/* quota / private */
					}
					// The banner component reads the flag from localStorage on mount;
					// a reload is the simplest way to re-evaluate it everywhere it's
					// rendered without threading an extra store action through.
					window.location.reload();
				}}
			/>

			<ServerIdentityCard heartbeat={heartbeat} nowMs={nowMs} />

			<RecentNotificationsCard
				items={recent}
				onDismiss={(id) => dismissNotification(id)}
			/>
		</div>
	);
}

/**
 * "Code from your phone." Two independent capabilities, one card: installing
 * the deck as a standalone app (no browser chrome, its own icon, launches
 * full-screen) and push notifications that reach it even when it's closed
 * or backgrounded — the thing a foreground-only browser Notification can't
 * do, which is the whole point of pairing the two here rather than putting
 * push in a generic "notifications" list.
 */
function MobileAppCard() {
	const install = useInstallPrompt();
	const push = usePushSubscription();
	const [installResult, setInstallResult] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<string | null>(null);

	async function handleInstall(): Promise<void> {
		const outcome = await install.promptInstall();
		if (outcome === "accepted") setInstallResult("Installed. Look for omp-deck on your home screen or app list.");
		else if (outcome === "dismissed") setInstallResult(null);
	}

	async function handleTest(): Promise<void> {
		try {
			setTestResult(await push.sendTest());
		} catch (err) {
			setTestResult(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="row space-y-3 pb-4">
			<div>
				<div className="text-sm font-medium">Mobile & push</div>
				<p className="mt-0.5 text-xs text-ink-3">
					Install omp-deck as an app and get pushed when a session needs you — even with the tab closed.
				</p>
			</div>

			<div className="flex items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2.5">
				<div className="min-w-0">
					<div className="text-xs font-medium text-ink">Install as app</div>
					<div className="mt-0.5 text-2xs text-ink-3">
						{install.installed
							? "Already running as an installed app."
							: install.needsManualIosInstructions
								? "Safari: Share → Add to Home Screen."
								: install.available
									? "Adds an icon, launches full-screen, no browser chrome."
									: "Not offered by this browser yet — visit again after using the app a bit, or check for a browser menu install option."}
					</div>
					{installResult ? <div className="mt-1 text-2xs text-success">{installResult}</div> : null}
				</div>
				{!install.installed && install.available ? (
					<Button variant="primary" size="sm" onClick={() => void handleInstall()}>
						Install
					</Button>
				) : null}
			</div>

			<div className="flex items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2.5">
				<div className="min-w-0">
					<div className="text-xs font-medium text-ink">Push notifications</div>
					<div className="mt-0.5 text-2xs text-ink-3">
						{push.state === "unsupported"
							? "Not supported by this browser."
							: push.state === "subscribed"
								? "Enabled on this device."
								: "Reach this device even when the tab is closed."}
					</div>
					{push.error ? <div className="mt-1 text-2xs text-danger">{push.error}</div> : null}
					{testResult ? <div className="mt-1 text-2xs text-ink-3">{testResult}</div> : null}
				</div>
				{push.state !== "unsupported" ? (
					<div className="flex shrink-0 gap-1.5">
						{push.state === "subscribed" ? (
							<>
								<Button variant="ghost" size="sm" disabled={push.busy} onClick={() => void handleTest()}>
									Test
								</Button>
								<Button variant="outline" size="sm" disabled={push.busy} onClick={() => void push.unsubscribe()}>
									Disable
								</Button>
							</>
						) : (
							<Button variant="primary" size="sm" disabled={push.busy} onClick={() => void push.subscribe()}>
								Enable
							</Button>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}

function PermissionCard({
	permission,
	onRequest,
}: {
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onRequest: () => void;
}) {
	const { t } = useTranslation();
	const tone =
		permission === "granted"
			? "success"
			: permission === "denied"
				? "danger"
				: permission === "unsupported"
					? "muted"
					: "warn";
	const label =
		permission === "granted"
			? t("Granted")
			: permission === "denied"
				? t("Denied")
				: permission === "unsupported"
					? t("Unsupported")
					: t("Not requested");

	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("Browser permission")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t("OS-level notifications when the deck tab is in the background.")}
					</div>
				</div>
				<Badge tone={tone}>{label}</Badge>
			</div>
			<div className="mt-3 text-xs text-ink-3">
				{permission === "default" ? (
					<>
						{t(
							"Permission has not been requested yet. The deck will only emit OS notifications after you grant access.",
						)}
					</>
				) : permission === "granted" ? (
					<>
						{t(
							"OS notifications will fire for items the server marks important (routine failures, long-running steps, agent task completions).",
						)}
					</>
				) : permission === "denied" ? (
					<>
						{t(
							"The browser is blocking notifications for this site. Re-enable from the site settings — usually the lock icon next to the address bar — then reload.",
						)}
					</>
				) : (
					<>{t("This browser doesn't expose the Notifications API.")}</>
				)}
			</div>
			{permission === "default" ? (
				<div className="mt-3">
					<Button size="sm" variant="primary" onClick={onRequest}>
						{t("Enable browser notifications")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function AudioCard({
	audioEnabled,
	onToggle,
}: {
	audioEnabled: boolean;
	onToggle: (enabled: boolean) => void;
}) {
	const { t } = useTranslation();
	const levels: NotificationLevel[] = ["info", "warn", "error", "critical"];
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("Audio cues")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t(
							"Synthesized tones layered on top of OS notifications. Each level has a distinct sequence — info is short, critical is loud.",
						)}
					</div>
				</div>
				<label className="flex items-center gap-2 text-xs text-ink-2">
					<input
						type="checkbox"
						checked={audioEnabled}
						onChange={(e) => onToggle(e.target.checked)}
					/>
					<span>{audioEnabled ? t("Enabled") : t("Muted")}</span>
				</label>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{levels.map((level) => (
					<Button
						key={level}
						size="sm"
						variant="outline"
						disabled={!audioEnabled}
						onClick={() => void playNotificationTone(level)}
					>
						<Play className="mr-1 h-3 w-3" />
						{level}
					</Button>
				))}
			</div>
			{!audioEnabled ? (
				<div className="mt-2 text-xs text-ink-3">{t("Enable audio to preview tones.")}</div>
			) : null}
		</div>
	);
}

function BannerResetCard({
	bannerDismissed,
	permission,
	onReset,
}: {
	bannerDismissed: boolean;
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onReset: () => void;
}) {
	const { t } = useTranslation();
	// Banner only ever shows when permission is "default" AND not dismissed,
	// so the reset is only meaningful in that combination.
	const canReset = bannerDismissed && permission === "default";
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("Permission banner")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t("The top-of-page nudge that asks you to enable notifications.")}
					</div>
					<div className="mt-1 text-xs text-ink-3">
						{permission !== "default"
							? t("Banner is suppressed because permission is already decided.")
							: bannerDismissed
								? t("You dismissed the banner. Reset to bring it back.")
								: t("Banner is currently visible.")}
					</div>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={!canReset}
					onClick={onReset}
				>
					<RotateCcw className="mr-1 h-3 w-3" />
					{t("Reset banner")}
				</Button>
			</div>
		</div>
	);
}

function ServerIdentityCard({
	heartbeat,
	nowMs,
}: {
	heartbeat:
		| {
				lastReceivedAtMs: number;
				serverStartedAt: string;
				pid: number;
				uptimeSecs: number;
				buildSha: string | null;
				version: string;
		  }
		| null;
	nowMs: number;
}) {
	const { t } = useTranslation();
	if (!heartbeat) {
		return (
			<div className="rounded-md border border-line bg-paper-2 p-4 text-xs text-ink-3">
				<div className="meta mb-1">{t("Server identity")}</div>
				{t("Waiting for the first heartbeat…")}
			</div>
		);
	}
	const ageMs = Math.max(0, nowMs - heartbeat.lastReceivedAtMs);
	const ageTone: "success" | "warn" | "danger" =
		ageMs < 10_000 ? "success" : ageMs < 30_000 ? "warn" : "danger";
	const ageLabel = ageMs < 1_000 ? t("just now") : t("{{seconds}}s ago", { seconds: Math.round(ageMs / 1000) });
	const shortSha = heartbeat.buildSha ? heartbeat.buildSha.slice(0, 7) : t("unknown");
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="meta">{t("Server identity")}</div>
				<Badge tone={ageTone}>{t("last heartbeat {{age}}", { age: ageLabel })}</Badge>
			</div>
			<dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-xs text-ink-2">
				<dt className="text-ink-3">pid</dt>
				<dd>{heartbeat.pid}</dd>
				<dt className="text-ink-3">version</dt>
				<dd>{heartbeat.version}</dd>
				<dt className="text-ink-3">build</dt>
				<dd>{shortSha}</dd>
				<dt className="text-ink-3">started</dt>
				<dd>{new Date(heartbeat.serverStartedAt).toLocaleString()}</dd>
				<dt className="text-ink-3">uptime</dt>
				<dd>{formatUptime(heartbeat.serverStartedAt)}</dd>
			</dl>
		</div>
	);
}

function RecentNotificationsCard({
	items,
	onDismiss,
}: {
	items: ReadonlyArray<NotificationItem>;
	onDismiss: (id: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">{t("Recent activity")}</div>
				<div className="mt-0.5 text-xs text-ink-3">
					{t(
						"Latest server-emitted notifications. Capped at 50 in memory; this list shows the freshest 20.",
					)}
				</div>
			</div>
			{items.length === 0 ? (
				<div className="px-3 py-6 text-center text-xs text-ink-3">
					{t("No notifications yet.")}
				</div>
			) : (
				<ul className="divide-y divide-line">
					{items.map((item) => (
						<li
							key={item.id}
							className={cn(
								"flex items-start gap-3 px-3 py-2 text-sm",
								item.dismissed && "opacity-60",
							)}
						>
							<Badge tone={notificationLevelTone(item.level)}>{item.level}</Badge>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-ink">{item.title}</div>
								{item.body ? (
									<div className="mt-0.5 text-xs text-ink-2">{item.body}</div>
								) : null}
								<div className="mt-1 font-mono text-2xs text-ink-3">
									{new Date(item.timestamp).toLocaleString()}
									{item.source ? ` · ${item.source}` : ""}
								</div>
							</div>
							{!item.dismissed ? (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => onDismiss(item.id)}
									aria-label={t("Dismiss")}
									title={t("Dismiss")}
								>
									<X className="h-3 w-3" />
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function notificationLevelTone(
	level: NotificationLevel,
): "default" | "accent" | "warn" | "danger" | "success" | "muted" {
	switch (level) {
		case "info":
			return "accent";
		case "warn":
			return "warn";
		case "error":
			return "danger";
		case "critical":
			return "danger";
		default:
			return "default";
	}
}

function ThemeCard({
	definition,
	isActive,
	isPinned,
	onPick,
}: {
	definition: (typeof THEMES)[number];
	isActive: boolean;
	isPinned: boolean;
	onPick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onPick}
			data-theme-preview={definition.id}
			aria-pressed={isActive}
			className={cn(
				"group flex flex-col gap-3 rounded-md border bg-paper p-3 text-left transition-colors",
				isActive ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-ink/30",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<div>
					<div className="text-sm font-semibold text-ink">{t(definition.label)}</div>
					<div className="mt-0.5 text-xs text-ink-3">{t(definition.description)}</div>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					{isActive ? <Badge tone="accent">{t("active")}</Badge> : null}
					{!isActive && isPinned ? <Badge tone="muted">{t("pinned")}</Badge> : null}
				</div>
			</div>
			<ThemeSwatchStrip definition={definition} />
		</button>
	);
}

function ThemeSwatchStrip({ definition }: { definition: (typeof THEMES)[number] }) {
	// Render swatches inside an isolated `data-theme="..."` wrapper so each card
	// shows its OWN palette regardless of which theme the rest of the UI uses.
	return (
		<div
			data-theme={definition.id}
			className="grid grid-cols-4 gap-1.5 rounded-md border border-line/60 bg-paper p-1.5"
		>
			{definition.swatchTokens.map((s) => (
				<div key={s.token} className="flex flex-col items-stretch gap-1">
					<div
						className="h-8 w-full rounded"
						style={{ backgroundColor: `rgb(var(--${s.token}))` }}
					/>
					<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
						{s.label}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Orientation section — surfaces the three artifacts that shape every deck
 * session so non-developer users can view and tweak them without touching
 * server source. See kb://system/imperatives-belong-in-orchestrator-not-prelude
 * for the prelude-vs-orchestrator architecture that motivated this surface.
 */
function OrientationSection() {
	const { t } = useTranslation();
	return (
		<div className="mx-auto max-w-5xl space-y-6">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("Orientation")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t(
						"Three artifacts shape every deck session: the system-prompt prelude, the {{start}} orchestrator fired on boot, and the maintenance-gate extension that nudges the agent to capture work mid-session. Edit each in place; changes take effect on the next session create (prelude) or the next slash invocation (start) or the next gate evaluation (maintenance).",
						{ start: <code className="font-mono text-xs">/start</code> },
					)}
				</p>
			</div>
			<PreludeCard />
			<StartCommandCard />
			<MaintenanceGateCard />
		</div>
	);
}

function PreludeCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<PreludeResponse | null>(null);
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getPrelude();
			setData(next);
			setDraft(next.override ?? next.default);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const usingOverride = data ? data.override !== null : false;
	const dirty = data ? draft !== (data.override ?? data.default) : false;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: draft });
			setData(next);
			setDraft(next.override ?? next.default);
			setStatus(t("Saved. New sessions will use this prelude."));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	async function resetToDefault(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: null });
			setData(next);
			setDraft(next.default);
			setStatus(t("Override cleared. New sessions will use the bundled default."));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("Prelude")}</div>
					{usingOverride ? <Badge tone="accent">{t("override")}</Badge> : <Badge tone="muted">{t("default")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t(
						"Prepended to every session's system prompt at {{fn}}. Imperatives belong in {{cmd}}, not here — the prelude is reference material that the orchestrator can rely on.",
						{
							fn: <code className="font-mono">createAgentSession</code>,
							cmd: <code className="font-mono">/start</code>,
						},
					)}
				</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{data?.path ?? "..."}
				</div>
			</div>
			<div className="space-y-3 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-ink-3">{t("Loading...")}</div>
				) : (
					<>
						<RichEditor
							value={draft}
							onChange={(v) => setDraft(v)}
							disableRichText
							className="block min-h-[320px] w-full resize-y rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink"
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
								<Save className="h-3.5 w-3.5" />
								{t("Save")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => void resetToDefault()}
								disabled={saving || !usingOverride}
							>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("Reset to default")}
							</Button>
							{dirty ? (
								<span className="font-mono text-2xs text-warn">{t("Unsaved changes")}</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function StartCommandCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<StartCommand | null>(null);
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getStartCommand();
			setData(next);
			setDescription(next.description);
			setBody(next.body);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const dirty = data ? description !== data.description || body !== data.body : false;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putStartCommand({ description, body });
			setData(next);
			setDescription(next.description);
			setBody(next.body);
			setStatus(t("Saved. Next /start invocation will use this body."));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("/start orchestrator")}</div>
					{data?.exists ? <Badge tone="default">{t("on disk")}</Badge> : <Badge tone="warn">{t("missing")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t(
						"First user message fired on session boot. Re-read every invocation, so saves take effect immediately. Numbered procedures here outrank prelude imperatives by recency — put DO-THIS instructions in this body, not in the prelude above.",
					)}
				</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{data?.path ?? "..."}
				</div>
			</div>
			<div className="space-y-3 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-ink-3">{t("Loading...")}</div>
				) : (
					<>
						<label className="block space-y-1">
							<span className="meta">{t("description")}</span>
							<input
								type="text"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder={t("One-line summary (frontmatter description:)")}
								className="block w-full rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs text-ink"
							/>
						</label>
						<label className="block space-y-1">
							<span className="meta">{t("body")}</span>
							<RichEditor
								value={body}
								onChange={(v) => setBody(v)}
								disableRichText
								className="block min-h-[280px] w-full resize-y rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink"
							/>
						</label>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
								<Save className="h-3.5 w-3.5" />
								{t("Save")}
							</Button>
							{dirty ? (
								<span className="font-mono text-2xs text-warn">{t("Unsaved changes")}</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function MaintenanceGateCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<MaintenanceGateState | null>(null);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		minOpMsgs: string;
		minReleaseAgeMs: string;
		fireFloorMs: string;
	} | null>(null);
	const [previewMode, setPreviewMode] = useState<"deck" | "flat-file">("deck");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getMaintenanceGate();
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	function parseKnob(value: string): number | null {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const n = Number.parseInt(trimmed, 10);
		return Number.isFinite(n) && n > 0 ? n : NaN;
	}

	async function save(): Promise<void> {
		if (!draft) return;
		const parsedOp = parseKnob(draft.minOpMsgs);
		const parsedRel = parseKnob(draft.minReleaseAgeMs);
		const parsedFire = parseKnob(draft.fireFloorMs);
		if (Number.isNaN(parsedOp) || Number.isNaN(parsedRel) || Number.isNaN(parsedFire)) {
			setError(t("Each knob must be a positive integer or empty (to clear override)."));
			return;
		}
		setSaving(true);
		try {
			const next = await orientationApi.putMaintenanceGate({
				enabled: draft.enabled,
				minOpMsgs: parsedOp,
				minReleaseAgeMs: parsedRel,
				fireFloorMs: parsedFire,
			});
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setStatus(t("Saved. Gate will use these values on the next evaluation."));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	const profile: "deck" | "flat-file" | "inactive" = !data
		? "inactive"
		: !data.enabled
			? "inactive"
			: data.orgRoot
				? "deck"
				: "flat-file";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("Maintenance gate")}</div>
					{profile === "deck" ? <Badge tone="accent">{t("deck profile")}</Badge> : null}
					{profile === "flat-file" ? <Badge tone="default">{t("flat-file profile")}</Badge> : null}
					{profile === "inactive" ? <Badge tone="muted">{t("inactive")}</Badge> : null}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t(
						"Nudges the agent at {{hook}} to capture insights / decisions / tasks into the appropriate destination. Fires at most once per release segment, gated by three floors. Disabling here skips org-root detection so even an unaltered installed extension stays silent.",
						{ hook: <code className="font-mono">turn_end</code> },
					)}
				</p>
				<div className="mt-1 space-y-0.5 font-mono text-2xs text-ink-3">
					<div>{t("extension: {{path}}", { path: data?.installedExtensionPath ?? "..." })}</div>
					<div>
						{t("installed: {{state}}", {
							state: data ? (data.installedExtensionPresent ? t("yes") : t("missing")) : "...",
						})}
					</div>
					<div>
						{t("OMP_DECK_ORG_ROOT: {{root}} ({{source}})", {
							root: data?.orgRoot ?? t("(unset)"),
							source: data?.orgRootSource ?? "",
						})}
					</div>
				</div>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft || !data ? (
					<div className="text-sm text-ink-3">{t("Loading...")}</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>{t("Enabled")}</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_MAINTENANCE_GATE_DISABLED = {data.disabledRaw ?? "(unset)"} ({data.disabledSource})
							</span>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<GateKnobInput
								label="minOpMsgs"
								help={t("Operator messages since last release")}
								knob={data.knobs.minOpMsgs}
								value={draft.minOpMsgs}
								onChange={(v) => setDraft({ ...draft, minOpMsgs: v })}
							/>
							<GateKnobInput
								label="minReleaseAgeMs"
								help={t("Wall-clock ms since last release")}
								knob={data.knobs.minReleaseAgeMs}
								value={draft.minReleaseAgeMs}
								onChange={(v) => setDraft({ ...draft, minReleaseAgeMs: v })}
							/>
							<GateKnobInput
								label="fireFloorMs"
								help={t("Wall-clock ms between fires (cross-session)")}
								knob={data.knobs.fireFloorMs}
								value={draft.fireFloorMs}
								onChange={(v) => setDraft({ ...draft, fireFloorMs: v })}
							/>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								{t("Save")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("Reload")}
							</Button>
							{!data.installedExtensionPresent ? (
								<span className="font-mono text-2xs text-warn">
									{t(
										"Extension not installed at expected path; knob changes won't take effect until it's restored.",
									)}
								</span>
							) : null}
						</div>

						<div className="overflow-hidden rounded-md border border-line bg-paper-2">
							<div className="flex items-center gap-2 border-b border-line px-3 py-2">
								<div className="meta">{t("Reminder preview")}</div>
								<div className="ml-auto flex items-center gap-1">
									<Button
										size="sm"
										variant={previewMode === "deck" ? "primary" : "outline"}
										onClick={() => setPreviewMode("deck")}
									>
										deck
									</Button>
									<Button
										size="sm"
										variant={previewMode === "flat-file" ? "primary" : "outline"}
										onClick={() => setPreviewMode("flat-file")}
									>
										flat-file
									</Button>
								</div>
							</div>
							<pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
								{previewMode === "deck" ? data.preview.deckMode : data.preview.flatFileMode}
							</pre>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function GateKnobInput({
	label,
	help,
	knob,
	value,
	onChange,
}: {
	label: string;
	help: string;
	knob: GateKnob;
	value: string;
	onChange: (v: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<label className="block space-y-1">
			<span className="meta">{label}</span>
			<input
				type="text"
				inputMode="numeric"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={String(knob.default)}
				className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
			/>
			<div className="font-mono text-2xs text-ink-3">
				{help}
			</div>
			<div className="font-mono text-2xs text-ink-3">
				{t("effective {{value}} · default {{default}} · source {{source}}", {
					value: knob.value,
					default: knob.default,
					source: knob.source,
				})}
			</div>
		</label>
	);
}

type AccessMode = "direct" | "tunnel" | "history";

function RemoteAccessSection() {
	const [mode, setMode] = useState<AccessMode>("direct");
	const [history, setHistory] = useState<AttachHistoryEntry[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [historyError, setHistoryError] = useState<string | undefined>();
	const [qrFor, setQrFor] = useState<string | null>(null);

	useEffect(() => {
		if (mode !== "history") return;
		setHistoryLoading(true);
		setHistoryError(undefined);
		attachApi
			.getAttachHistory()
			.then((resp) => setHistory(resp.entries))
			.catch((e: unknown) => setHistoryError(e instanceof Error ? e.message : String(e)))
			.finally(() => setHistoryLoading(false));
	}, [mode]);

	const cloudflaredCmd = "cloudflared tunnel --url http://localhost:3000";

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Remote Access</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					Pick how your phone reaches this deck. Switch modes any time; settings are saved per
					device.
				</p>
			</div>

			<div className="grid gap-3">
				<AccessModeCard
					id="direct"
					mode={mode}
					setMode={setMode}
					title="Direct (loopback + Tailscale)"
					description="Connect directly via your local IP or Tailscale domain. No public exposure; fastest and safest when both devices are on the same network or Tailscale tailnet."
					default
				/>
				<AccessModeCard
					id="tunnel"
					mode={mode}
					setMode={setMode}
					title="Cloudflare Tunnel"
					description="Run cloudflared on the host machine. The deck stays unexposed; Cloudflare handles TLS and routing."
					footer={
						<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1.5">
							<code className="flex-1 truncate font-mono text-xs">{cloudflaredCmd}</code>
							<CopyButton text={cloudflaredCmd} />
						</div>
					}
				/>
				<AccessModeCard
					id="history"
					mode={mode}
					setMode={setMode}
					title="Join Links History"
					description="Recent attach URLs you've minted. Scan a QR from a previous session to rejoin quickly."
					footer={
						<JoinLinksHistory
							entries={history}
							loading={historyLoading}
							error={historyError}
							onOpenQr={(sessionId) => setQrFor(sessionId)}
						/>
					}
				/>
			</div>

			{qrFor ? (
				<SessionAttachQR
					sessionId={qrFor}
					open={true}
					onClose={() => setQrFor(null)}
				/>
			) : null}
		</div>
	);
}

function AccessModeCard({
	id,
	mode,
	setMode,
	title,
	description,
	footer,
	default: isDefault,
}: {
	id: AccessMode;
	mode: AccessMode;
	setMode: (m: AccessMode) => void;
	title: string;
	description: string;
	footer?: ReactNode;
	default?: boolean;
}) {
	const selected = mode === id;
	return (
		<label
			className={cn(
				"block cursor-pointer rounded-md border bg-paper-2 p-3 transition-colors",
				selected ? "border-accent ring-1 ring-accent/30" : "border-line hover:border-ink-3",
			)}
		>
			<div className="flex items-start gap-3">
				<input
					type="radio"
					name="access-mode"
					value={id}
					checked={selected}
					onChange={() => setMode(id)}
					className="mt-1 h-3.5 w-3.5 accent-accent"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<div className="font-mono text-xs font-medium uppercase tracking-meta">
							{title}
						</div>
						{isDefault ? <Badge tone="accent">default</Badge> : null}
					</div>
					<p className="mt-1 text-sm text-ink-3">{description}</p>
					{footer && selected ? <div className="mt-3">{footer}</div> : null}
				</div>
			</div>
		</label>
	);
}

function JoinLinksHistory({
	entries,
	loading,
	error,
	onOpenQr,
}: {
	entries: AttachHistoryEntry[];
	loading: boolean;
	error: string | undefined;
	onOpenQr: (sessionId: string) => void;
}) {
	if (loading) return <div className="text-sm text-ink-3">Loading history...</div>;
	if (error) {
		return (
			<div className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-2xs text-danger">
				{error}
			</div>
		);
	}
	if (entries.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-line bg-paper-2 px-2 py-1.5 text-xs text-ink-3">
				No join links yet. Mint one from a running session to see it here.
			</div>
		);
	}
	return (
		<ul className="divide-y divide-line rounded-md border border-line bg-paper-2">
			{entries.map((entry) => (
				<li key={entry.token} className="flex items-center gap-2 px-2 py-1.5">
					<div className="min-w-0 flex-1">
						<div className="truncate font-mono text-xs">{entry.url}</div>
						<div className="text-2xs text-ink-3">
							{new Date(entry.createdAt).toLocaleString()} · {entry.sessionId.slice(0, 8)}
						</div>
					</div>
					<CopyButton text={entry.url} />
					<Button variant="outline" size="sm" onClick={() => onOpenQr(entry.sessionId)}>
						<QrIcon className="h-3.5 w-3.5" />
						QR
					</Button>
				</li>
			))}
		</ul>
	);
}

function StubSection({ section }: { section: Exclude<SectionId, "env" | "messaging" | "appearance" | "notifications" | "remote-access"> }) {
	const { t } = useTranslation();
	const spec = SECTIONS.find((s) => s.id === section)!;
	return (
		<div className="mx-auto max-w-3xl rounded-md border border-dashed border-line bg-paper-2 p-6">
			<div className="meta">{t(spec.label)}</div>
			<h1 className="mt-2 text-xl font-semibold">{t("Not built yet")}</h1>
			<p className="mt-1 text-sm text-ink-3">{t("This section is reserved so the settings layout is stable.")}</p>
		</div>
	);
}

function SettingsSideRail() {
	const { t } = useTranslation();
	return <div className="p-3 text-xs text-ink-3">{t("Settings")}</div>;
}

function SettingsInspector() {
	const { t } = useTranslation();
	return (
		<div className="space-y-2 p-3 text-xs text-ink-3">
			<div className="meta">{t("Settings notes")}</div>
			<p>
				{t(
					"Secrets are masked in list responses. Replace values here; do not reveal unless using the loopback API directly.",
				)}
			</p>
		</div>
	);
}

function normalizeSection(raw: string | null): SectionId {
	return SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : "env";
}

function sourceLabel(source: EnvEntry["source"]): string {
	if (source === "process-env") return i18n.t("process env");
	if (source === "env-file") return i18n.t(".env file");
	return source;
}

function sourceTone(source: EnvEntry["source"]): "accent" | "default" | "muted" {
	if (source === "process-env") return "accent";
	if (source === "env-file") return "default";
	return "muted";
}

function envApplyBadge(entry: EnvEntry) {
	if (entry.hotApply) return <Badge tone="success">{i18n.t("hot")}</Badge>;
	if (entry.restartTarget === "telegram-bridge") return <Badge tone="warn">{i18n.t("bridge restart")}</Badge>;
	if (entry.restartRequired) return <Badge tone="warn">{i18n.t("server restart")}</Badge>;
	return <Badge tone="muted">{i18n.t("manual")}</Badge>;
}

function bridgeStatusTone(status: BridgeInfo["status"]): "success" | "muted" | "warn" | "danger" {
	if (status === "running") return "success";
	if (status === "starting") return "warn";
	if (status === "crashed") return "danger";
	return "muted";
}

function bridgeStatusLabel(status: BridgeInfo["status"], info: BridgeInfo | undefined): string {
	if (status === "running") return i18n.t("running");
	if (status === "starting") return i18n.t("starting");
	if (status === "crashed")
		return info?.exitSignal ? i18n.t("crashed ({{signal}})", { signal: info.exitSignal }) : i18n.t("crashed");
	if (info && info.missingEnv.length > 0) return i18n.t("missing credentials");
	return i18n.t("stopped");
}

function formatUptime(startedIso: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedIso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24}h`;
}

/**
 * Providers section — list every OAuth-capable provider with its current
 * auth state. Login opens OAuthFlowModal; Revoke clears credentials and
 * fires `models_changed` server-side so the picker re-empties without a
 * deck restart. See docs/oauth-deck-sdk-findings.md for the SDK contract.
 */
/**
 * Your deck account: who you're signed in as, how to change the password, and
 * how to leave.
 *
 * On a deck with authentication disabled (the loopback-only case) this becomes
 * an explanation of why there is nothing to configure, rather than a form that
 * cannot do anything — the difference between "not applicable" and "broken" is
 * worth the extra branch.
 */
function AccountSection() {
	const [status, setStatus] = useState<AuthStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function refresh(): Promise<void> {
		setLoading(true);
		try {
			setStatus(await deckAuthApi.status());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function changePassword(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		setError(null);
		setNotice(null);
		if (next !== confirm) {
			setError("The two new passwords don't match.");
			return;
		}
		setBusy(true);
		try {
			await deckAuthApi.changePassword(current, next);
			setCurrent("");
			setNext("");
			setConfirm("");
			setNotice("Password changed. Every other signed-in device has been signed out.");
		} catch (err) {
			setError((err as AuthError).message || "Could not change the password.");
		} finally {
			setBusy(false);
		}
	}

	async function signOut(): Promise<void> {
		await deckAuthApi.logout().catch(() => undefined);
		// Full reload rather than a router navigation: it tears down the
		// WebSocket and every cached store slice, so nothing from the old
		// session lingers in memory behind the login screen.
		window.location.reload();
	}

	if (loading) return <div className="font-mono text-2xs text-ink-3">Loading …</div>;

	if (status && !status.authRequired) {
		return (
			<div className="flex flex-col gap-3">
				<div className="meta">Account</div>
				<p className="max-w-prose text-sm text-ink-2">
					Authentication is off. The deck only does that when it is bound to loopback and no password is
					configured, so the only thing that can reach it is this machine.
				</p>
				<p className="max-w-prose text-sm text-ink-2">
					Publishing it on a hostname turns authentication on automatically. To require a password here too,
					set <code>OMP_DECK_AUTH_MODE=on</code> and <code>OMP_DECK_AUTH_PASSWORD</code>, then restart.
				</p>
			</div>
		);
	}

	return (
		<div className="flex max-w-md flex-col gap-5">
			<div className="flex flex-col gap-2">
				<div className="meta">Signed in as</div>
				<div className="row items-center justify-between">
					<span className="font-mono text-sm text-ink">{status?.user?.username ?? "unknown"}</span>
					<Button variant="outline" onClick={() => void signOut()}>
						Sign out
					</Button>
				</div>
			</div>

			<form onSubmit={changePassword} className="flex flex-col gap-3">
				<div className="meta">Change password</div>
				<label className="block">
					<div className="meta mb-1">Current password</div>
					<input
						className="field h-9 w-full px-2 text-sm"
						type="password"
						autoComplete="current-password"
						value={current}
						onChange={(e) => setCurrent(e.target.value)}
						required
					/>
				</label>
				<label className="block">
					<div className="meta mb-1">New password</div>
					<input
						className="field h-9 w-full px-2 text-sm"
						type="password"
						autoComplete="new-password"
						minLength={8}
						value={next}
						onChange={(e) => setNext(e.target.value)}
						required
					/>
				</label>
				<label className="block">
					<div className="meta mb-1">Confirm new password</div>
					<input
						className="field h-9 w-full px-2 text-sm"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						required
					/>
				</label>
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{notice ? <div className="text-xs text-ink-2">{notice}</div> : null}
				<Button type="submit" variant="primary" disabled={busy} className="self-start">
					{busy ? "Saving…" : "Change password"}
				</Button>
			</form>
		</div>
	);
}

function ProvidersSection() {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [activeFlow, setActiveFlow] = useState<{ id: string; name: string } | null>(null);
	const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);
	const [revoking, setRevoking] = useState(false);

	async function refresh(): Promise<void> {
		try {
			const resp = await authApi.listProviders();
			setProviders(resp.providers);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function revoke(): Promise<void> {
		if (!confirmRevoke) return;
		setRevoking(true);
		try {
			await authApi.revoke(confirmRevoke.id);
			setConfirmRevoke(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(false);
		}
	}

	if (loading) {
		return <div className="font-mono text-2xs text-ink-3">{t("Loading providers…")}</div>;
	}
	if (error) {
		return (
			<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
				{error}
			</div>
		);
	}
	if (!providers) return null;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="meta">{t("Providers")}</h2>
				<p className="mt-1 text-xs text-ink-3">
					{t(
						"OAuth sign-in to subscription providers (Claude Pro/Max, ChatGPT Plus/Pro, etc.). API keys live under {{env}} — this surface is for browser-flow auth.",
						{ env: <strong>Env</strong> },
					)}
				</p>
			</div>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{providers.map((p) => (
					<ProviderCard
						key={p.id}
						info={p}
						onLogin={() => setActiveFlow({ id: p.id, name: p.name })}
						onRevoke={() => setConfirmRevoke({ id: p.id, name: p.name })}
					/>
				))}
			</div>
			<OAuthFlowModal
				open={activeFlow !== null}
				provider={activeFlow?.id ?? null}
				providerName={activeFlow?.name ?? null}
				onClose={() => setActiveFlow(null)}
				onComplete={() => {
					setActiveFlow(null);
					void refresh();
				}}
			/>
			<Modal open={confirmRevoke !== null} onClose={() => setConfirmRevoke(null)} widthClass="max-w-md">
				<div className="flex flex-col gap-3 p-5">
					<h2 className="text-base font-semibold text-ink">
						{t("Sign out of {{name}}?", { name: confirmRevoke?.name })}
					</h2>
					<p className="text-xs text-ink-3">
						{t(
							"The stored credentials will be deleted from {{db}}. Token refresh will fail until you log in again. Other deck instances sharing the same {{dir}} will lose access too.",
							{
								db: <code>auth.db</code>,
								dir: <code>OMP_AGENT_DIR</code>,
							},
						)}
					</p>
					<div className="flex justify-end gap-2 border-t border-line pt-3">
						<Button variant="ghost" onClick={() => setConfirmRevoke(null)} disabled={revoking}>
							{t("Cancel")}
						</Button>
						<Button variant="danger" onClick={revoke} disabled={revoking}>
							{revoking ? t("Signing out…") : t("Sign out")}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}

function ProviderCard({
	info,
	onLogin,
	onRevoke,
}: {
	info: ProviderInfo;
	onLogin: () => void;
	onRevoke: () => void;
}) {
	const { t } = useTranslation();
	const tone =
		info.state === "oauth"
			? "border-success/40 bg-success/5"
			: info.state === "api-key"
				? "border-accent/30 bg-accent-soft/40"
				: "border-line bg-paper-2/30";
	const stateLabel =
		info.state === "oauth"
			? t("OAuth (subscription)")
			: info.state === "api-key"
				? t("API key configured")
				: t("Not configured");
	const stateBadgeTone: "success" | "accent" | "default" =
		info.state === "oauth" ? "success" : info.state === "api-key" ? "accent" : "default";
	return (
		<div className={cn("flex flex-col gap-2 rounded border p-3", tone)}>
			<div className="flex items-baseline justify-between gap-2">
				<div className="truncate text-sm font-medium text-ink" title={info.name}>
					{info.name}
				</div>
				<Badge tone={stateBadgeTone}>{stateLabel}</Badge>
			</div>
			<div className="font-mono text-2xs text-ink-4">
				{info.id}
				{info.count > 1 ? (
					<span className="ml-1.5">{t("· {{count}} credentials", { count: info.count })}</span>
				) : null}
			</div>
			<div className="mt-1 flex gap-2">
				{info.state === "unconfigured" ? (
					<Button variant="primary" onClick={onLogin} className="flex-1">
						{t("Login")}
					</Button>
				) : info.state === "oauth" ? (
					<>
						<Button variant="outline" onClick={onLogin} className="flex-1">
							{t("Replace")}
						</Button>
						<Button variant="ghost" onClick={onRevoke}>
							{t("Sign out")}
						</Button>
					</>
				) : (
					<Button variant="outline" onClick={onLogin} className="flex-1">
						{t("Login (replaces API key)")}
					</Button>
				)}
			</div>
		</div>
	);
}
