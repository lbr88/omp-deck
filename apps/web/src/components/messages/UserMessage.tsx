import { useTranslation } from "react-i18next";
import type { UserMsg } from "@/lib/types";
import { Markdown } from "@/lib/markdown";

export function UserMessage({ msg }: { msg: UserMsg }) {
	const { t } = useTranslation();
	return (
		<div className="space-y-1.5">
			<div className="meta">
				{t("you")}
				{msg.synthetic ? <span className="ml-1.5 text-thinking">· {t("synthetic")}</span> : null}
			</div>
			{msg.images && msg.images.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{msg.images.map((img, i) => (
						<img
							key={i}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("pasted {{n}}", { n: i + 1 })}
							className="h-28 w-28 rounded border border-line object-cover"
						/>
					))}
				</div>
			) : null}
			{msg.text ? <Markdown>{msg.text}</Markdown> : null}
		</div>
	);
}
