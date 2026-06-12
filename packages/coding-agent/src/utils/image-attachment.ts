import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "./image-resize.ts";
import { detectSupportedImageMimeType } from "./mime.ts";

/**
 * Outcome of running raw image bytes through the shared sniff + resize pipeline.
 * `note` carries the human-readable text for each status — a dimension note for
 * `ok` (present only when the image was downscaled), or the reason the image was
 * dropped for `tooLarge`/`unsupported`. Callers own how the note is surfaced to
 * the model (e.g. `<file>` tags, a `read` prefix, or an appended message line).
 */
export type PreparedImageAttachment =
	| { status: "ok"; image: ImageContent; mimeType: string; note?: string }
	| { status: "tooLarge"; mimeType: string; note: string }
	| { status: "unsupported"; note: string };

export interface PrepareImageAttachmentOptions {
	/** When true, resize to the inline limits; when false, attach original bytes. */
	autoResize: boolean;
	/** Label used in generated notes, e.g. "Image" or "Image 2". Default: "Image". */
	label?: string;
	/**
	 * Pre-sniffed mime type. When provided, the content sniff is skipped — used by
	 * the `read` tool, which classifies via its pluggable, path-based operations
	 * and already knows the type. When omitted, the type is sniffed from the bytes.
	 */
	mimeType?: string;
}

/**
 * Sniff the real mime type from decoded image bytes and produce an attachable
 * `ImageContent`. When `autoResize` is on, the image is resized to the inline
 * limits (reported as `tooLarge` if it cannot be brought under them); when off,
 * the original bytes are attached with the sniffed mime type. This is the single
 * pipeline shared by CLI file arguments, RPC-supplied images, and the `read`
 * tool, so a session never contains an image that did not pass it.
 */
export async function prepareImageAttachment(
	bytes: Uint8Array,
	options: PrepareImageAttachmentOptions,
): Promise<PreparedImageAttachment> {
	const label = options.label ?? "Image";
	const mimeType = options.mimeType ?? detectSupportedImageMimeType(bytes);
	if (!mimeType) {
		return {
			status: "unsupported",
			note: `[${label} omitted: not a supported image format (png, jpeg, gif, webp).]`,
		};
	}

	if (!options.autoResize) {
		return {
			status: "ok",
			mimeType,
			image: { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") },
		};
	}

	const resized = await resizeImage(bytes, mimeType);
	if (!resized) {
		return {
			status: "tooLarge",
			mimeType,
			note: `[${label} omitted: could not be resized below the inline image size limit.]`,
		};
	}
	return {
		status: "ok",
		mimeType: resized.mimeType,
		image: { type: "image", mimeType: resized.mimeType, data: resized.data },
		note: formatDimensionNote(resized, label),
	};
}
