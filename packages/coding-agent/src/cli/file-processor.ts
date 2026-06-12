/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { prepareImageAttachment } from "../utils/image-attachment.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		let content: Buffer;
		try {
			content = await readFile(absolutePath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
			process.exit(1);
		}

		const prepared = await prepareImageAttachment(content, { autoResize: autoResizeImages });

		if (prepared.status === "ok") {
			images.push(prepared.image);
			text += prepared.note
				? `<file name="${absolutePath}">${prepared.note}</file>\n`
				: `<file name="${absolutePath}"></file>\n`;
		} else if (prepared.status === "tooLarge") {
			text += `<file name="${absolutePath}">${prepared.note}</file>\n`;
		} else {
			// Not a supported image: treat as a text file
			text += `<file name="${absolutePath}">\n${content.toString("utf-8")}\n</file>\n`;
		}
	}

	return { text, images };
}
