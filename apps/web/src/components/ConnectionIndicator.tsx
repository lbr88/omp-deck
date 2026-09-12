/**
 * Compact connection indicator for the header. Reads heartbeat metadata
 * from the store; renders a tiny dot:
 *   - green  : last heartbeat within 10s (healthy)
 *   - yellow : 10-20s gap (reconnecting / slow)
 *   - red    : >20s gap or no heartbeat ever (disconnected)
 *
 * Hovering reveals serverStartedAt, version, buildSha, uptime. Click
 * targets the same details for touch.
 *
 * Tick interval is 1s — cheap, and the dot needs to flip without waiting
 * for the next heartbeat to arrive.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "../lib/store";
import { size as idbQueueSize } from "../lib/idb-queue";

const HEALTHY_MS = 10_000;
const WARN_MS = 20_000;

type DotColor = "green" | "yellow" | "red";

function classify(gapMs: number, hasHeartbeat: boolean): DotColor {
	if (!hasHeartbeat) return "red";
	if (gapMs < HEALTHY_MS) return "green";
	if (gapMs < WARN_MS) return "yellow";
	return "red";
}

function colorClass(color: DotColor): string {
	switch (color) {
		case "green":
			return "bg-emerald-500";
		case "yellow":
			return "bg-amber-400";
		case "red":
			return "bg-rose-500";
	}
}

function formatUptime(secs: number): string {
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
	return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

export function ConnectionIndicator(): JSX.Element {
	const { t } = useTranslation();
	const heartbeat = useStore((s) => s.heartbeat);
	const wsStatus = useStore((s) => s.wsStatus);
	const unauthorized = useStore((s) => s.unauthorized);
	const [now, setNow] = useState(Date.now());
	const [queued, setQueued] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	// Poll the IDB queue depth every 2s so the "N queued" pill reflects
	// surviving offline frames without bespoke hooks. The cost is one
	// `count()` over a tiny object store per tick — negligible.
	useEffect(() => {
		let cancelled = false;
		const tick = async (): Promise<void> => {
			idbQueueSize()
				.then((n) => {
					if (!cancelled) setQueued(n);
				})
				.catch(() => {});
		};
		void tick();
		const t = setInterval(() => tick(), 2000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, []);

	const gap = heartbeat ? now - heartbeat.lastReceivedAtMs : Infinity;
	const color = classify(gap, heartbeat !== null);
	const label = unauthorized
		? t("signed out")
		: color === "green"
			? t("connected")
			: color === "yellow"
				? t("reconnecting")
				: heartbeat === null
					? t("no heartbeat yet")
					: t("disconnected");

	const tooltip = unauthorized
		? t("Signed out — the deck requires the access token. The login screen will ask for it.")
		: heartbeat
		? [
				t("status: {{value}}", { value: label }),
				t("ws: {{value}}", { value: wsStatus }),
				t("gap: {{value}}s since last heartbeat", { value: (gap / 1000).toFixed(1) }),
				t("server started: {{value}}", { value: heartbeat.serverStartedAt }),
				t("uptime: {{value}}", { value: formatUptime(heartbeat.uptimeSecs) }),
				t("version: {{value}}", { value: heartbeat.version }),
				heartbeat.buildSha
					? t("build: {{value}}", { value: heartbeat.buildSha.slice(0, 8) })
					: t("build: unknown"),
				t("pid: {{value}}", { value: heartbeat.pid }),
		  ].join("\n")
		: [
				t("status: {{value}}", { value: label }),
				t("ws: {{value}}", { value: wsStatus }),
				t("waiting for the deck server to broadcast a heartbeat"),
		  ].join("\n");

	return (
		<button
			type="button"
			title={tooltip}
			aria-label={t("server {{status}}", { status: label })}
			className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800/60"
		>
			{queued > 0 ? (
				<span
					className="inline-flex items-center rounded-full bg-amber-500/20 px-1.5 py-0.5 font-mono text-2xs text-amber-300"
					title={`${queued} frame${queued === 1 ? "" : "s"} queued in IDB, will replay on reconnect`}
				>
					{queued} queued
				</span>
			) : null}
			<span
				className={`inline-block h-2 w-2 rounded-full ${colorClass(color)} ${
					color === "yellow" ? "animate-pulse" : ""
				}`}
				aria-hidden="true"
			/>
			<span className="hidden sm:inline">{label}</span>
		</button>
	);
}
