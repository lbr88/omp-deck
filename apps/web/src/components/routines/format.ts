import type { Routine } from "@omp-deck/protocol";

import i18n from "@/i18n";

/** Human-readable cron expression — "07:00 daily", "every minute", etc. */
export function describeCron(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [m, h, dom, mon, dow] = parts;
	const everyMin = m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*";
	if (everyMin) return i18n.t("every minute");
	const fixedTime = /^\d+$/.test(m ?? "") && /^\d+$/.test(h ?? "");
	const timeStr = fixedTime ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "";
	if (timeStr && dom === "*" && mon === "*" && dow === "*") return i18n.t("{{time}} daily", { time: timeStr });
	if (timeStr && dom === "*" && mon === "*" && dow === "1-5") return i18n.t("{{time}} weekdays", { time: timeStr });
	if (timeStr && dom === "*" && mon === "*" && /^\d$/.test(dow ?? "")) {
		const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		return i18n.t("{{time}} {{day}}", { time: timeStr, day: i18n.t(days[Number(dow)]!) });
	}
	if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return i18n.t("hourly");
	return expr;
}

export function countdown(toIso: string | undefined, from: Date = new Date()): string {
	if (!toIso) return "";
	const t = new Date(toIso).getTime();
	if (Number.isNaN(t)) return "";
	const ms = t - from.getTime();
	if (ms <= 0) return i18n.t("now");
	const min = Math.floor(ms / 60_000);
	if (min < 1) return i18n.t("<1m");
	const h = Math.floor(min / 60);
	if (h < 1) return i18n.t("{{min}}m", { min });
	const d = Math.floor(h / 24);
	if (d < 1) return i18n.t("{{h}}h {{min}}m", { h, min: min % 60 });
	return i18n.t("{{d}}d {{h}}h", { d, h: h % 24 });
}

export function routineSubtitle(r: Routine): string {
	const bits: string[] = [];
	if (r.cron) bits.push(describeCron(r.cron));
	if (r.timezone) bits.push(r.timezone);
	return bits.join(" · ");
}
