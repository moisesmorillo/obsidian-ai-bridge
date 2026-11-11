import {
	McpCreateBaseInputSchema,
	McpDeleteBaseInputSchema,
	McpListBasesInputSchema,
	McpReadBaseInputSchema,
	McpUpdateBaseInputSchema,
	McpValidateBaseInputSchema,
	McpValidateBaseResultSchema,
} from "@vaultwire/protocol";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const etag = `"${epoch}.1"`;
const content = "views:\n  - type: table\n    name: Open\n";

describe("canonical Base MCP contracts", () => {
	it("accepts each of the six bounded Base tool requests", () => {
		expect(McpListBasesInputSchema.parse({ prefix: "Career Ops/" })).toEqual({
			prefix: "Career Ops/",
		});
		expect(
			McpReadBaseInputSchema.parse({
				path: "pipeline.base",
				etag,
				offset: 0,
				length: 32,
			}),
		).toMatchObject({ path: "pipeline.base" });
		expect(
			McpCreateBaseInputSchema.parse({ path: "pipeline.base", content, epoch }),
		).toMatchObject({ path: "pipeline.base" });
		expect(
			McpUpdateBaseInputSchema.parse({ path: "pipeline.base", content, etag }),
		).toMatchObject({ path: "pipeline.base" });
		expect(
			McpDeleteBaseInputSchema.parse({ path: "pipeline.base", etag }),
		).toEqual({ path: "pipeline.base", etag });
		expect(McpValidateBaseInputSchema.parse({ content })).toEqual({ content });
		expect(
			McpValidateBaseResultSchema.parse({
				epoch,
				valid: true,
				level: "structural-only",
				diagnostics: [],
			}),
		).toMatchObject({ epoch, valid: true });
	});

	it("rejects non-Base suffixes, traversal, oversized content, and extra fields", () => {
		for (const path of [
			"pipeline.md",
			"pipeline.base.backup",
			"../pipeline.base",
		])
			expect(McpReadBaseInputSchema.safeParse({ path }).success).toBe(false);
		expect(
			McpCreateBaseInputSchema.safeParse({
				path: "pipeline.base",
				content: "x".repeat(65_537),
				epoch,
			}).success,
		).toBe(false);
		expect(
			McpValidateBaseInputSchema.safeParse({ content, user_id: "forged" })
				.success,
		).toBe(false);
	});
});
