import { useTranslation } from "react-i18next";
import { selectActiveSession, useStore } from "@/lib/store";
import { TodoPanel } from "./todos/TodoPanel";
import { CostStrip } from "./chrome/CostStrip";
import { ModeBanner } from "./chrome/ModeBanner";
import { shortPath } from "@/lib/utils";

export function Inspector() {
	const { t } = useTranslation();
	const session = useStore(selectActiveSession);

	if (!session) {
		return (
			<div className="px-4 py-6 font-mono text-2xs uppercase tracking-meta text-ink-3">
				{t("No session selected")}
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<Section title={t("Session")}>
				<KV k="id" v={short(session.sessionId)} title={session.sessionId} />
				{session.sessionName ? <KV k="name" v={session.sessionName} /> : null}
				<KV k="cwd" v={shortPath(session.cwd, 32)} title={session.cwd} />
				{session.sessionFile ? (
					<KV k="file" v={shortPath(session.sessionFile, 32)} title={session.sessionFile} />
				) : null}
				{session.model ? (
					<KV k="model" v={`${session.model.provider}/${session.model.id}`} />
				) : null}
				{session.thinkingLevel ? <KV k="think" v={session.thinkingLevel} /> : null}
			</Section>

			<ModeBanner mode={session.mode} goal={session.goal ?? undefined} />
			<CostStrip usage={session.usage} turns={session.turnCount} />
			<TodoPanel phases={session.todoPhases} />
		</div>
	);
}

export function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2">{title}</div>
			<div className="space-y-1.5">{children}</div>
		</section>
	);
}

function KV({ k, v, title }: { k: string; v: string; title?: string }) {
	return (
		<div className="grid grid-cols-[56px_1fr] gap-2 font-mono text-2xs">
			<span className="text-ink-3">{k}</span>
			<span className="truncate text-ink" title={title ?? v}>
				{v}
			</span>
		</div>
	);
}

function short(id: string): string {
	if (id.length <= 12) return id;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
