import { useTranslation } from "react-i18next";
import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, extractResultText } from "./shared";

export function GenerateImageTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const subject = String((args.subject as string | undefined) ?? "");
	const result = stream?.result;
	const imageData = extractImage(result);
	const text = result ? extractResultText(result) : "";

	return (
		<div className="space-y-1.5">
			<ArgRow k="subject" v={subject} />
			{imageData ? (
				<img
					src={`data:${imageData.mimeType};base64,${imageData.data}`}
					alt={t("generated")}
					className="max-h-96 rounded border border-line"
				/>
			) : null}
			{!imageData && text ? <div className="font-mono text-2xs text-ink-3">{text}</div> : null}
		</div>
	);
}

function extractImage(result: unknown): { data: string; mimeType: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	if (typeof r.data === "string" && typeof r.mimeType === "string") {
		return { data: r.data, mimeType: r.mimeType };
	}
	if (Array.isArray(r.content)) {
		for (const c of r.content) {
			if (c && typeof c === "object") {
				const obj = c as Record<string, unknown>;
				if (obj.type === "image" && typeof obj.data === "string") {
					return { data: obj.data as string, mimeType: String(obj.mimeType ?? "image/png") };
				}
			}
		}
	}
	return undefined;
}
