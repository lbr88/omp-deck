/**
 * Image upload surface for task bodies (and any other markdown body the deck
 * renders). The contract is intentionally narrow:
 *
 * - Single endpoint: `POST /api/uploads/image` with either a `multipart/form-data`
 *   payload (field name `file`) OR a raw binary body whose `content-type` starts
 *   with `image/`.
 * - Server validates content-type against a whitelist (png / jpeg / gif / webp /
 *   svg+xml), enforces a max size, hashes the bytes (sha256), and writes them to
 *   `<dataDir>/uploads/<yyyy>/<mm>/<hash>.<ext>`. Content-addressed paths mean
 *   re-pasting the same image is a no-op disk-wise.
 * - Response: `{ url, name, size, mimeType }`. `url` is rooted at `/uploads/...`
 *   so it works for both browser-side <img src> and agent-written markdown.
 *
 * Files are served back via the static handler in `index.ts` mounted at
 * `/uploads/*` so they show up wherever the markdown renderer runs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { Hono } from "hono";

import i18n from "./i18n";
import { logger } from "./log.ts";

const log = logger("routes:uploads");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap — way more than a screenshot

/**
 * MIME → file extension. The keys are the only types we accept. We deliberately
 * exclude `image/heic` and friends (browsers don't render them inline) and
 * `image/avif` (uneven decoder support across embedded webviews).
 */
const ACCEPTED_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

export interface UploadsConfig {
	/** Absolute filesystem root for stored uploads, typically `<dataDir>/uploads`. */
	uploadsRoot: string;
}

/**
 * Best-effort filename sanitizer for the response `name` field. We never use
 * the client-supplied name on disk — the hash-based filename is the only thing
 * that hits the filesystem — but a clean display name helps when an agent
 * inspects the upload response.
 */
function sanitizeDisplayName(raw: string | undefined, fallbackExt: string): string {
	if (!raw) return `image.${fallbackExt}`;
	// Strip path separators and control characters; clamp length.
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 120);
	return cleaned || `image.${fallbackExt}`;
}

/**
 * Two-deep date sharding (`yyyy/mm`) keeps any single directory bounded for
 * `ls`/file managers. Production deployments that grow past tens of thousands
 * of files can swap this for a deeper scheme without touching the URL contract.
 */
function dateShard(now: Date): { yyyy: string; mm: string } {
	const yyyy = String(now.getUTCFullYear());
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	return { yyyy, mm };
}

export interface SavedUpload {
	url: string;
	name: string;
	size: number;
	mimeType: string;
}

/**
 * Validation failure caused by the client (bad type, empty, oversized) rather
 * than a server fault. The HTTP layer maps it to 400. Classified by kind —
 * not by message text — so the status stays correct once the message is
 * translated (i18n) and is no longer greppable in English.
 */
export class UploadInputError extends Error {}

/**
 * Internal: persist a single in-memory image to disk under the content-addressed
 * path. Exported for the unit tests; the HTTP layer wraps it with validation.
 */
export async function persistImage(
	root: string,
	bytes: Uint8Array,
	mimeType: string,
	displayName: string | undefined,
	now: Date = new Date(),
): Promise<SavedUpload> {
	const ext = ACCEPTED_MIME[mimeType];
	if (!ext) throw new UploadInputError(i18n.t("unsupported image type: {{mimeType}}", { mimeType }));
	if (bytes.byteLength === 0) throw new UploadInputError(i18n.t("empty upload"));
	if (bytes.byteLength > MAX_BYTES) {
		throw new UploadInputError(
			i18n.t("upload exceeds {{maxBytes}} bytes (got {{actualBytes}})", {
				maxBytes: MAX_BYTES,
				actualBytes: bytes.byteLength,
			}),
		);
	}

	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
	const { yyyy, mm } = dateShard(now);
	const dir = path.join(root, yyyy, mm);
	await fs.mkdir(dir, { recursive: true });
	const filename = `${hash}.${ext}`;
	const full = path.join(dir, filename);

	// Idempotent: if the same bytes were already uploaded, skip the write so
	// re-pasting a screenshot doesn't churn the disk.
	try {
		const stat = await fs.stat(full);
		if (stat.size === bytes.byteLength) {
			return {
				url: `/uploads/${yyyy}/${mm}/${filename}`,
				name: sanitizeDisplayName(displayName, ext),
				size: bytes.byteLength,
				mimeType,
			};
		}
	} catch {
		// not present yet; fall through to write
	}

	await fs.writeFile(full, bytes);
	return {
		url: `/uploads/${yyyy}/${mm}/${filename}`,
		name: sanitizeDisplayName(displayName, ext),
		size: bytes.byteLength,
		mimeType,
	};
}

export function buildUploadsRouter(config: UploadsConfig): Hono {
	const app = new Hono();

	app.post("/uploads/image", async (c) => {
		const contentType = c.req.header("content-type") ?? "";

		try {
			let bytes: Uint8Array;
			let mimeType: string;
			let displayName: string | undefined;

			if (contentType.toLowerCase().startsWith("multipart/form-data")) {
				const form = await c.req.formData();
				const file = form.get("file");
				if (!(file instanceof File)) {
					return c.json({ error: i18n.t("multipart upload requires 'file' field") }, 400);
				}
				bytes = new Uint8Array(await file.arrayBuffer());
				mimeType = (file.type || "").toLowerCase();
				displayName = file.name;
			} else if (contentType.toLowerCase().startsWith("image/")) {
				bytes = new Uint8Array(await c.req.arrayBuffer());
				mimeType = contentType.split(";", 1)[0]!.trim().toLowerCase();
				displayName = c.req.header("x-upload-name") ?? undefined;
			} else {
				return c.json(
					{
						error: i18n.t(
							"send either multipart/form-data with a 'file' field, or a raw body with content-type: image/*",
						),
					},
					400,
				);
			}

			if (!ACCEPTED_MIME[mimeType]) {
				return c.json({ error: i18n.t("unsupported image type: {{mimeType}}", { mimeType }) }, 415);
			}

			const saved = await persistImage(config.uploadsRoot, bytes, mimeType, displayName);
			return c.json(saved, 201);
		} catch (err) {
			const msg = String(err instanceof Error ? err.message : err);
			// Size/type/empty failures are user errors; everything else is 500.
			const status = err instanceof UploadInputError ? 400 : 500;
			if (status === 500) log.error(`upload failed`, err);
			return c.json({ error: msg }, status);
		}
	});

	return app;
}
