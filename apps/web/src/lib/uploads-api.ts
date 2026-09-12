/**
 * Client for the deck's image upload endpoint.
 *
 * The server accepts either multipart/form-data or a raw image body. We use
 * the raw-body path because:
 *   - Paste/drop events hand us a `File`/`Blob` directly; no need to wrap.
 *   - One fewer layer to debug when the response is misshapen.
 *
 * Response shape mirrors the server's `SavedUpload`.
 */

const BASE = "/api";

export interface UploadedImage {
	url: string;
	name: string;
	size: number;
	mimeType: string;
}

export async function uploadImage(blob: Blob, name?: string): Promise<UploadedImage> {
	const headers: Record<string, string> = {
		"content-type": blob.type || "application/octet-stream",
	};
	if (name) headers["x-upload-name"] = encodeURIComponent(name);

	const res = await fetch(`${BASE}/uploads/image`, {
		method: "POST",
		headers,
		body: blob,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} /uploads/image: ${body}`);
	}
	return (await res.json()) as UploadedImage;
}
