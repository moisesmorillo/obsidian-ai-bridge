import { ETagSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Declared SHA-256 identity and exact byte count for one request body. */
export const BlobDeclarationSchema = z
	.object({
		payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
		size: z.number().int().nonnegative().safe().max(25_000_000),
	})
	.strict();

/** Immutable blob metadata returned with an authorized file observation. */
export const BlobMetadataSchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema,
		hash: z.string().regex(/^(?:[0-9a-f]{64})?$/),
		size: z.number().int().nonnegative().safe().max(25_000_000),
		kind: z.literal("blob"),
		deleted: z.boolean(),
		origin: z.string(),
		updated_at: z.number().int().safe(),
		large: z.boolean(),
	})
	.strict()
	.superRefine((metadata, ctx) => {
		if (metadata.deleted) {
			if (metadata.hash !== "" || metadata.size !== 0 || metadata.large) {
				ctx.addIssue({
					code: "custom",
					message: "tombstone metadata must be empty",
				});
			}
			return;
		}
		if (metadata.hash.length !== 64) {
			ctx.addIssue({
				code: "custom",
				message: "live blob metadata needs a hash",
			});
		}
		const large =
			/\.(?:md|canvas)$/i.test(metadata.path) && metadata.size > 1_000_000;
		if (metadata.large !== large) {
			ctx.addIssue({
				code: "custom",
				message: "large marker does not match blob path and size",
			});
		}
	});

/** A selected inclusive byte interval with a bounded response length. */
export interface ByteRangeSelection {
	/** First selected byte, inclusive. */
	start: number;
	/** Last selected byte, inclusive. */
	end: number;
}

/** Selects one valid HTTP byte range, or returns undefined for invalid requests. */
export function selectByteRange(
	value: string,
	size: number,
): ByteRangeSelection | undefined {
	if (
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		!/^bytes=(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)?$/.test(value)
	)
		return undefined;
	const match = /^bytes=(0|[1-9][0-9]*)-(?:(0|[1-9][0-9]*))?$/.exec(value);
	if (!match) return undefined;
	const start = Number(match[1]);
	const requestedEnd = match[2] === undefined ? size - 1 : Number(match[2]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start >= size ||
		requestedEnd < start
	)
		return undefined;
	const end = Math.min(requestedEnd, size - 1);
	if (end - start + 1 > 1_000_000) {
		if (match[2] !== undefined) return undefined;
		return { start, end: start + 999_999 };
	}
	return { start, end };
}
