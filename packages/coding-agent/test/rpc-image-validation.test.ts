/**
 * Tests for the RPC image pipeline: images supplied via the `prompt`/`steer`/
 * `follow_up` RPC commands are content-sniffed and resized like the other
 * ingestion paths; bad images are dropped and replaced by a text note in the
 * message so they never enter the session.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { processRpcImages } from "../src/modes/rpc/rpc-command-handler.ts";
import { loadPhoton } from "../src/utils/photon.ts";

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

function image(base64Data: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data: base64Data, mimeType };
}

/**
 * Bytes that pass the PNG content sniff (valid signature + IHDR chunk header)
 * but cannot be decoded — signature checks alone don't catch this case.
 */
function corruptBodyPng(): string {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrLength = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
	const ihdrType = Buffer.from("IHDR", "ascii");
	const garbage = Buffer.alloc(64, 0xff);
	return Buffer.concat([signature, ihdrLength, ihdrType, garbage]).toString("base64");
}

/** Generate a valid PNG larger than the 2000x2000 inline limit. */
async function oversizedPng(): Promise<string> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon not available in test environment");
	const source = photon.PhotonImage.new_from_byteslice(Buffer.from(TINY_PNG, "base64"));
	try {
		const enlarged = photon.resize(source, 2200, 2200, photon.SamplingFilter.Nearest);
		try {
			return Buffer.from(enlarged.get_bytes()).toString("base64");
		} finally {
			enlarged.free();
		}
	} finally {
		source.free();
	}
}

const AUTO_RESIZE = { autoResize: true };

describe("processRpcImages", () => {
	it("passes through a valid image and overrides the client-supplied mime type", async () => {
		const result = await processRpcImages("look at this", [image(TINY_PNG, "image/jpeg")], AUTO_RESIZE);

		expect(result.message).toBe("look at this");
		expect(result.images).toHaveLength(1);
		expect(result.images![0].mimeType).toBe("image/png");
		expect(result.images![0].data).toBe(TINY_PNG);
	});

	it("leaves message and images untouched when no images are supplied", async () => {
		expect(await processRpcImages("hello", undefined, AUTO_RESIZE)).toEqual({ message: "hello", images: undefined });
		expect(await processRpcImages("hello", [], AUTO_RESIZE)).toEqual({ message: "hello", images: [] });
	});

	it("drops bytes that are not a supported image and appends a note", async () => {
		const garbage = Buffer.from("definitely not an image").toString("base64");
		const result = await processRpcImages("look at this", [image(garbage)], AUTO_RESIZE);

		expect(result.images).toBeUndefined();
		expect(result.message).toBe(
			"look at this\n\n[Image 1 omitted: not a supported image format (png, jpeg, gif, webp).]",
		);
	});

	it("drops an undecodable image that passes the content sniff", async () => {
		const result = await processRpcImages("look at this", [image(corruptBodyPng())], AUTO_RESIZE);

		expect(result.images).toBeUndefined();
		expect(result.message).toBe(
			"look at this\n\n[Image 1 omitted: could not be resized below the inline image size limit.]",
		);
	});

	it("uses the note as the whole message when the message is empty", async () => {
		const garbage = Buffer.from("definitely not an image").toString("base64");
		const result = await processRpcImages("", [image(garbage)], AUTO_RESIZE);

		expect(result.message).toBe("[Image 1 omitted: not a supported image format (png, jpeg, gif, webp).]");
	});

	it("resizes oversized images and appends an indexed dimension note", async () => {
		const result = await processRpcImages("look at this", [image(await oversizedPng())], AUTO_RESIZE);

		expect(result.images).toHaveLength(1);
		expect(result.message).toContain("[Image 1: original 2200x2200, displayed at 2000x2000.");
	});

	it("keeps good images and notes bad ones by index", async () => {
		const garbage = Buffer.from("definitely not an image").toString("base64");
		const result = await processRpcImages("look at these", [image(TINY_PNG), image(garbage)], AUTO_RESIZE);

		expect(result.images).toHaveLength(1);
		expect(result.images![0].data).toBe(TINY_PNG);
		expect(result.message).toBe(
			"look at these\n\n[Image 2 omitted: not a supported image format (png, jpeg, gif, webp).]",
		);
	});

	it("attaches original bytes without resizing or a note when auto-resize is off", async () => {
		const oversized = await oversizedPng();
		const result = await processRpcImages("look at this", [image(oversized)], { autoResize: false });

		expect(result.images).toHaveLength(1);
		// Original bytes are attached verbatim; with auto-resize on they would be downscaled.
		expect(result.images![0].data).toBe(oversized);
		expect(result.images![0].mimeType).toBe("image/png");
		expect(result.message).toBe("look at this");
	});

	it("still rejects unsupported formats when auto-resize is off", async () => {
		const garbage = Buffer.from("definitely not an image").toString("base64");
		const result = await processRpcImages("look at this", [image(garbage)], { autoResize: false });

		expect(result.images).toBeUndefined();
		expect(result.message).toBe(
			"look at this\n\n[Image 1 omitted: not a supported image format (png, jpeg, gif, webp).]",
		);
	});
});
