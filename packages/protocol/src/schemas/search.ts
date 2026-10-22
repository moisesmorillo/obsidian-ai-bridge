import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { FileFailureSchema } from "@protocol/schemas/files";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Search failures assigned by the canonical Unicode query bounds. */
export const SearchQueryFailureSchema = z.enum([
	"query_too_short",
	"query_too_long",
]);

/** Query text that passes the canonical 3–200 Unicode code-point bounds. */
export const SearchQuerySchema = z.string().superRefine((query, ctx) => {
	const length = Array.from(query).length;
	if (length < 3) {
		ctx.addIssue({ code: "custom", message: "query_too_short" });
	} else if (length > 200) {
		ctx.addIssue({ code: "custom", message: "query_too_long" });
	}
});

/** Result limit with the canonical 1–50 range and default value. */
export const SearchLimitSchema = z.number().int().min(1).max(50).default(20);

/** Return the canonical public failure for an out-of-range query, if any. */
export function searchQueryFailure(query: string) {
	const parsed = SearchQuerySchema.safeParse(query);
	if (parsed.success) return undefined;
	const failure = SearchQueryFailureSchema.safeParse(
		parsed.error.issues[0]?.message,
	);
	return failure.success ? failure.data : undefined;
}

/** Request for literal Markdown search with the canonical query and limit rules. */
export const SearchRequestSchema = z
	.object({ query: SearchQuerySchema, limit: SearchLimitSchema })
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
