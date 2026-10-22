import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { FileFailureSchema } from "@protocol/schemas/files";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Request for literal Markdown search with a code-point bounded query. */
export const SearchRequestSchema = z
	.object({
		query: z.string().refine((query) => {
			const length = Array.from(query).length;
			return length >= 3 && length <= 200;
		}),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.strict();

/** One ranked result with an ETag from the response epoch. */
export const SearchHitSchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema,
		snippet: z.string(),
		score: z.number().finite(),
	})
	.strict();

/** Successful public response with consistent indexed-file coverage. */
export const SearchResultSchema = z
	.object({
		epoch: EpochSchema,
		results: z.array(SearchHitSchema).max(50),
		indexed_files: z.number().int().nonnegative(),
		unindexed_large_files: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((result, ctx) => {
		for (const hit of result.results) {
			if (!hit.etag.startsWith(`"${result.epoch}.`)) {
				ctx.addIssue({
					code: "custom",
					message: "result ETag epoch does not match response",
				});
			}
			if (Array.from(hit.snippet).length > 1024) {
				ctx.addIssue({
					code: "custom",
					message: "snippet exceeds code-point limit",
				});
			}
		}
	});

/** Search RPC response with a canonical policy failure or complete result. */
export const SearchResponseSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), body: SearchResultSchema }).strict(),
	z.object({ ok: z.literal(false), failure: FileFailureSchema }).strict(),
]);
