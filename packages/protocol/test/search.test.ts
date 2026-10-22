import {
	encodeFileFailure,
	FileFailureSchema,
	SearchRequestSchema,
	SearchResponseSchema,
	SearchResultSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

describe("search protocol", () => {
	it("validates query code points and preserves literal input", () => {
		const astral = "😀";
		expect(SearchRequestSchema.safeParse({ query: "ab" }).success).toBe(false);
		expect(SearchRequestSchema.parse({ query: `${astral}ab` }).query).toBe(
			`${astral}ab`,
		);
		const query = `  AND " OR cafe\u0301  `;
		expect(SearchRequestSchema.parse({ query }).query).toBe(query);
		expect(
			SearchRequestSchema.safeParse({ query: "a".repeat(200) }).success,
		).toBe(true);
		expect(
			SearchRequestSchema.safeParse({ query: `${astral}${"a".repeat(200)}` })
				.success,
		).toBe(false);
	});

	it("defaults and bounds the result limit", () => {
		expect(SearchRequestSchema.parse({ query: "abc" }).limit).toBe(20);
		for (const limit of [1, 20, 50]) {
			expect(SearchRequestSchema.parse({ query: "abc", limit }).limit).toBe(
				limit,
			);
		}
		for (const limit of [0, 51, 1.5]) {
			expect(
				SearchRequestSchema.safeParse({ query: "abc", limit }).success,
			).toBe(false);
		}
	});

	it("encodes safe query-length failures as HTTP 400", () => {
		for (const [kind, message] of [
			["query_too_short", "The search query is too short."],
			["query_too_long", "The search query is too long."],
		] as const) {
			expect(FileFailureSchema.safeParse({ kind }).success).toBe(true);
			expect(encodeFileFailure({ kind })).toMatchObject({
				status: 400,
				body: { message },
			});
		}
	});

	it("requires epoch-bound result etags and finite scores", () => {
		const epoch = `a${"0".repeat(31)}`;
		const result = {
			epoch,
			results: [
				{
					path: "Notes/test.md",
					etag: `"${epoch}.1"`,
					snippet: "matched text",
					score: -0.1,
				},
			],
			indexed_files: 1,
			unindexed_large_files: 0,
		};
		expect(SearchResultSchema.safeParse(result).success).toBe(true);
		expect(
			SearchResultSchema.safeParse({
				...result,
				results: [
					{ ...result.results[0], etag: `"${`b${"0".repeat(31)}`}.1"` },
				],
			}).success,
		).toBe(false);
		expect(
			SearchResultSchema.safeParse({ ...result, extra: true }).success,
		).toBe(false);
		expect(
			SearchResultSchema.safeParse({
				...result,
				results: [{ ...result.results[0], score: Number.NaN }],
			}).success,
		).toBe(false);
		expect(
			SearchResponseSchema.safeParse({
				ok: false,
				failure: { kind: "query_too_short" },
				extra: true,
			}).success,
		).toBe(false);
	});
});
