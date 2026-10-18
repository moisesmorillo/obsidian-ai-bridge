import { z } from "zod";

/** Validates complete inline text without UTF-8 replacement or byte overflow. */
export const FullTextContentSchema = z.string().superRefine((content, ctx) => {
	const bytes = new TextEncoder().encode(content);
	if (bytes.byteLength > 1_000_000) {
		ctx.addIssue({ code: "custom", message: "text input too large" });
	}
	const decoded = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	}).decode(bytes);
	if (decoded !== content) {
		ctx.addIssue({ code: "custom", message: "text is not exact UTF-8" });
	}
});

/** Validates complete text, its lowercase SHA-256 digest, and original byte size. */
export const TextPayloadSchema = z
	.object({
		content: FullTextContentSchema,
		payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
		size: z.number().int().nonnegative().safe(),
	})
	.strict()
	.superRefine((payload, ctx) => {
		if (new TextEncoder().encode(payload.content).byteLength !== payload.size) {
			ctx.addIssue({
				code: "custom",
				message: "text byte size does not match",
			});
		}
	});
