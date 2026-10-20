import {
	type TextPayload,
	TextPayloadSchema,
} from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";

export type { TextPayload } from "@obsidian-ai-bridge/protocol";

/** Decodes valid bounded UTF-8 and hashes the exact source bytes. */
export async function prepareTextPayload(
	bytes: Uint8Array,
): Promise<TextPayload> {
	const originalSize = bytes.byteLength;
	if (originalSize > 1_000_000) {
		throw new FileOperationDenied({ kind: "text_too_large" });
	}

	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		throw new FileOperationDenied({ kind: "invalid_request" });
	}

	// Fatal UTF-8 decoding preserves exact bytes, including a BOM with ignoreBOM enabled.

	const hashInput = new Uint8Array(originalSize);
	hashInput.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", hashInput.buffer);
	const payload_hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return TextPayloadSchema.parse({
		content,
		payload_hash,
		size: originalSize,
	});
}
