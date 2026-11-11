import { McpListResultBudget } from "@worker/application/mcp-list-budget";
import { describe, expect, it } from "vitest";

/** Create one list row with a controlled serialized path length. */
function entry(path: string) {
	return {
		path,
		etag: '"epoch.1"',
		size: 1,
		updated_at: 1,
		large: false,
	};
}

describe("McpListResultBudget", () => {
	it("accepts 256 entries and rejects the next entry", () => {
		const budget = new McpListResultBudget();
		for (let index = 0; index < 256; index += 1)
			expect(budget.add(entry(`Notes/${index}.md`))).toBe(true);
		expect(budget.add(entry("Notes/late.md"))).toBe(false);
	});

	it("accounts for the envelope and accepts the exact byte ceiling", () => {
		const seed = entry("");
		const fixedBytes = new TextEncoder().encode(
			JSON.stringify(seed),
		).byteLength;
		const exact = entry("x".repeat(65_536 - 128 - fixedBytes));
		const budget = new McpListResultBudget();
		expect(budget.add(exact)).toBe(true);
		expect(budget.add(entry("late"))).toBe(false);
	});

	it("includes the envelope and separator at the exact byte boundary", () => {
		const first = entry("first");
		const secondBase = entry("");
		const availablePathBytes =
			65_536 -
			128 -
			new TextEncoder().encode(JSON.stringify(first)).byteLength -
			1 -
			new TextEncoder().encode(JSON.stringify(secondBase)).byteLength;
		const budget = new McpListResultBudget();
		expect(budget.add(first)).toBe(true);
		expect(budget.add(entry("x".repeat(availablePathBytes)))).toBe(true);
		expect(budget.add(entry("late"))).toBe(false);
	});

	it("measures serialized rows in UTF-8 bytes", () => {
		const budget = new McpListResultBudget();
		const multibyte = entry("é".repeat(32_740));
		expect(multibyte.path.length).toBeLessThan(65_536);
		expect(budget.add(multibyte)).toBe(false);
	});
});
