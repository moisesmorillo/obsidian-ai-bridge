import { validateBaseContent } from "@protocol/codecs/bases";
import { describe, expect, it } from "vitest";

/** Official-style Base config with opaque formulas and views. */
const officialBase = `filters:\n  and:\n    - file.ext == "md"\nformulas:\n  score: 'if(status == "open", 1, 0)'\nproperties:\n  file.name:\n    displayName: Name\nviews:\n  - type: table\n    name: Opportunities\n    filters:\n      or:\n        - status == "Open"\n        - priority == "High"\n    summaries:\n      score: Average\n    groupBy:\n      property: status\n      direction: ASC\n    order:\n      - file.name\n      - score\n    columns:\n      - file.name\n      - score\nsummaries:\n  customAverage: 'values.mean().round(3)'\n`;

/** Checks valid structure without exposing parsed Base values. */
describe("validateBaseContent", () => {
	it("accepts official fields, opaque expressions, and unknown plugin fields", () => {
		const result = validateBaseContent(
			`${officialBase}pluginField:\n  custom: true\n`,
		);
		expect(result.valid).toBe(true);
		expect(result.level).toBe("structural-only");
		expect(result.diagnostics).toEqual([]);
		expect(result).not.toHaveProperty("data");
	});

	it("accepts a two-view Opportunities configuration", () => {
		const content = officialBase.replace(
			"summaries:\\n  customAverage",
			'  - type: cards\\n    name: Pipeline\\n    filters: status == "Open"\\n    properties:\\n      - file.name\\nsummaries:\\n  customAverage',
		);
		expect(validateBaseContent(content).valid).toBe(true);
	});

	it.each([
		["invalid YAML", "views: ["],
		["duplicate keys", "views: []\nviews: []"],
		["multiple documents", "views: []\n---\nviews: []"],
		["scalar root", "hello"],
		["invalid known fields", "views: nope"],
		[
			"malformed recursive filters",
			"filters:\n  and:\n    - and:\n        - or: nope",
		],
	])("rejects %s", (_label, content) => {
		const result = validateBaseContent(content);
		expect(result.valid).toBe(false);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	it("accepts an empty mapping", () => {
		expect(validateBaseContent("{}").valid).toBe(true);
	});

	it.each([
		["UTF-8 byte", "x".repeat(65_537)],
		["lexical token", `a: ${"x: ".repeat(16_384)}`],
		["depth", `${"a:\n".repeat(33)}x`],
		["alias", "a: &anchor value\nb: *anchor"],
		["anchor", "a: &anchor value"],
		["tag", "a: !custom value"],
		["block indicators", `${"- ".repeat(33)}value`],
		["parser stack", `[${"[".repeat(40)}0${"]".repeat(40)}]`],
		[
			"syntax nodes",
			`${Array.from({ length: 5_500 }, (_, index) => `k${index}: v`).join("\\n")}\\n`,
		],
	])("bounds %s violations", (_label, content) => {
		const result = validateBaseContent(content);
		expect(result.valid).toBe(false);
	});

	it("bounds pathological parser work and diagnostic text", () => {
		const deepFlow = `[${"[".repeat(20_000)}0${"]".repeat(20_000)}]`;
		const result = validateBaseContent(deepFlow);
		expect(result.valid).toBe(false);
		expect(result.diagnostics.length).toBeLessThanOrEqual(8);
		for (const diagnostic of result.diagnostics)
			expect(diagnostic.length).toBeLessThanOrEqual(256);
	});
});
