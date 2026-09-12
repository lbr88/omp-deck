import { useTranslation } from "react-i18next";
import type { SessionUi } from "@/lib/types";

interface Props {
	mode: SessionUi["mode"];
	goal: SessionUi["goal"];
}

export function ModeBanner({ mode, goal }: Props) {
	const { t } = useTranslation();
	if (!mode && !goal) return null;
	const goalText =
		goal && typeof goal === "object" && (goal as { goal?: unknown }).goal
			? String(
					(goal as { goal?: { description?: unknown; summary?: unknown } }).goal?.description ??
						(goal as { goal?: { description?: unknown; summary?: unknown } }).goal?.summary ??
						t("(set)"),
				)
			: undefined;
	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2">{t("Mode")}</div>
			<div className="space-y-1.5 font-mono text-2xs">
				{mode ? (
					<div className="flex items-center gap-1.5">
						<span className="text-accent">{mode.mode}</span>
						{mode.data && typeof mode.data === "object" && "planFile" in (mode.data as Record<string, unknown>) ? (
							<span className="truncate text-ink-3 normal-case tracking-normal">
								{String((mode.data as Record<string, unknown>).planFile)}
							</span>
						) : null}
					</div>
				) : null}
				{goalText !== undefined ? (
					<div className="text-ink-2 normal-case tracking-normal">
						<span className="text-ink-3">
							{t("goal: {{value}}", { value: goalText })}
						</span>
					</div>
				) : null}
			</div>
		</section>
	);
}
