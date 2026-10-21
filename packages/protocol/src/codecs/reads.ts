import {
	ReadCursorContextSchema,
	ReadCursorSchema,
} from "@protocol/schemas/reads";
import type { ReadCursor, ReadCursorContext } from "@protocol/types/reads";

/** Maximum encoded cursor size checked before base64 decoding or JSON parsing. */
const MAX_CURSOR_BYTES = 4096;

/** Encodes a validated cursor as UTF-8 JSON in unpadded base64url form. */
export function encodeReadCursor(cursor: ReadCursor): string {
	const parsed = ReadCursorSchema.parse(cursor);
	const bytes = new TextEncoder().encode(JSON.stringify(parsed));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return encodeBase64Url(binary);
}

/** Decodes a bounded cursor and checks collection and epoch bindings before use. */
export function decodeReadCursor(
	token: string,
	context: ReadCursorContext,
): ReadCursor {
	ReadCursorContextSchema.parse(context);
	if (new TextEncoder().encode(token).byteLength > MAX_CURSOR_BYTES)
		throw new Error("read cursor exceeds 4096 bytes");
	if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1)
		throw new Error("read cursor encoding is malformed");
	const binary = atob(
		token.replaceAll("-", "+").replaceAll("_", "/") +
			"=".repeat((4 - (token.length % 4)) % 4),
	);
	const canonical = encodeBase64Url(binary);
	if (canonical !== token)
		throw new Error("read cursor encoding is not canonical");
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	let decoded: unknown;
	try {
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
	} catch {
		throw new Error("read cursor payload is malformed");
	}
	const cursor = ReadCursorSchema.parse(decoded);
	if (cursor.kind !== context.kind)
		throw new Error("read cursor collection does not match");
	if (cursor.epoch !== context.epoch)
		throw new Error("read cursor epoch does not match");
	if (
		cursor.kind === "history" &&
		(context.kind !== "history" || cursor.path !== context.path)
	)
		throw new Error("history cursor path does not match");
	return cursor;
}

/** Encode binary bytes as canonical unpadded base64url for both creation and validation. */
function encodeBase64Url(binary: string): string {
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
