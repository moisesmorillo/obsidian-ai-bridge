import {
	McpHistoryResultSchema,
	McpListNotesInputSchema,
	McpReadNoteInputSchema,
	McpSearchNotesInputSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

describe("MCP read schemas", () => {
	it("accepts bounded list and read inputs", () => {
		expect(
			McpListNotesInputSchema.safeParse({ prefix: "Agents/" }).success,
		).toBe(true);
		expect(
			McpReadNoteInputSchema.safeParse({
				path: "Agents/Log/2026-10-24.md",
				offset: 10,
				length: 20,
			}).success,
		).toBe(true);
	});

	it("rejects unknown fields and invalid search bounds", () => {
		expect(
			McpListNotesInputSchema.safeParse({ prefix: "", identity: "forged" })
				.success,
		).toBe(false);
		expect(McpSearchNotesInputSchema.safeParse({ query: "ab" }).success).toBe(
			false,
		);
	});

	it("requires epoch-bearing history results", () => {
		expect(
			McpHistoryResultSchema.safeParse({
				epoch: "0123456789abcdef0123456789abcdef",
				entries: [],
			}).success,
		).toBe(true);
		expect(McpHistoryResultSchema.safeParse({ entries: [] }).success).toBe(
			false,
		);
	});
});
