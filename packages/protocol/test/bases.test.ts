import { checkCstBounds, validateBaseContent } from "@protocol/codecs/bases";
import { BaseContentSchema } from "@protocol/schemas/bases";
import { describe, expect, it, vi } from "vitest";
import { Parser, parse } from "yaml";

/** Official-style Base config with opaque formulas and views. */
const officialBase = `filters:\n  and:\n    - file.ext == "md"\nformulas:\n  score: 'if(status == "open", 1, 0)'\nproperties:\n  file.name:\n    displayName: Name\nviews:\n  - type: table\n    name: Opportunities\n    filters:\n      or:\n        - status == "Open"\n        - priority == "High"\n    summaries:\n      score: Average\n    groupBy:\n      property: status\n      direction: ASC\n    order:\n      - file.name\n      - score\n    columns:\n      - file.name\n      - score\nsummaries:\n  customAverage: 'values.mean().round(3)'\n`;

/** Checks valid structure without exposing parsed Base values. */
describe("validateBaseContent", () => {
	it("checks the syntax-node ceiling directly with repeated hand-built CST tokens", () => {
		const [token] = [...new Parser().parse("value")];
		expect(token).toBeDefined();
		if (!token) throw new Error("Expected a parser token fixture");
		expect(checkCstBounds(Array.from({ length: 16_385 }, () => token))).toBe(
			"YAML syntax node limit exceeded",
		);
	});
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
			"summaries:\n  customAverage",
			'  - type: cards\n    name: Pipeline\n    filters: status == "Open"\n    properties:\n      - file.name\nsummaries:\n  customAverage',
		);
		const parsed = BaseContentSchema.parse(parse(content));
		expect(parsed.views).toHaveLength(2);
		expect(validateBaseContent(content).valid).toBe(true);
	});

	it("preserves unknown plugin fields in public configuration parsing", () => {
		const parsed = BaseContentSchema.parse({
			pluginConfig: { enabled: true },
			views: [{ type: "custom-map", pluginState: { zoom: 4 } }],
		});
		expect(parsed).toMatchObject({
			pluginConfig: { enabled: true },
			views: [{ pluginState: { zoom: 4 } }],
		});
	});

	it("refuses oversized input before encoding the full string", () => {
		const encode = vi.spyOn(TextEncoder.prototype, "encode");
		try {
			const result = validateBaseContent(`${"x".repeat(65_536)}é`);
			expect(result.diagnostics[0]).toContain("UTF-8 bytes");
			expect(encode).not.toHaveBeenCalled();
		} finally {
			encode.mockRestore();
		}
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

	it.each([
		[
			"invalid or sibling",
			'filters:\n  and:\n    - file.ext == "md"\n  or: 7\n',
		],
		[
			"invalid not sibling",
			'filters:\n  or:\n    - file.ext == "md"\n  not: nope\n',
		],
		[
			"invalid nested sibling",
			'filters:\n  and:\n    - or:\n        - file.ext == "md"\n      not: { bad: true }\n',
		],
	])(
		"rejects malformed known filter operator siblings: %s",
		(_label, content) => {
			expect(validateBaseContent(content).valid).toBe(false);
		},
	);

	it("does not expose raw malformed YAML content in diagnostics", () => {
		const sentinel = "PRIVATE_MARKER";
		const result = validateBaseContent(`x: |${sentinel}\n  text\n`);
		expect(result.valid).toBe(false);
		expect(result.diagnostics.join(" ")).not.toContain(sentinel);
		expect(result.diagnostics.join(" ")).not.toContain("x: |");
	});

	it("accepts an empty mapping", () => {
		expect(validateBaseContent("{}").valid).toBe(true);
	});

	it("rejects numeric formula scalars because official Bases syntax stores formulas as YAML strings", () => {
		expect(validateBaseContent("formulas:\n  score: 5\n").valid).toBe(false);
	});

	it.each([
		[
			"UTF-8 byte",
			`${"x".repeat(65_536)}é`,
			"Base YAML exceeds 65536 UTF-8 bytes",
		],
		[
			"lexical token",
			`[${Array.from({ length: 8_500 }, (_, index) => `k${index}`).join(",")}]`,
			"YAML lexical token limit exceeded",
		],
		[
			"depth",
			`${Array.from({ length: 32 }, (_, index) => `${"  ".repeat(index)}k${index}:`).join("\n")}\n${"  ".repeat(32)}value`,
			"YAML structure depth limit exceeded",
		],
		["alias", "a: *anchor", "YAML aliases are not supported"],
		["anchor", "a: &anchor value", "YAML anchors are not supported"],
		["tag", "a: !custom value", "YAML tags are not supported"],
		[
			"block indicators",
			`${"- ".repeat(33)}value`,
			"YAML line indicator limit exceeded",
		],
		[
			"parser stack",
			`[${"[".repeat(40)}0${"]".repeat(40)}]`,
			"YAML parser stack limit exceeded",
		],
		[
			"syntax node candidate reaches lexical token limit first",
			`${Array.from({ length: 5_500 }, (_, index) => `k${index}: v`).join("\n")}\n`,
			"YAML lexical token limit exceeded",
		],
	])("bounds %s violations", (_label, content, diagnostic) => {
		const result = validateBaseContent(content);
		expect(result.valid).toBe(false);
		expect(result.diagnostics[0]).toContain(diagnostic);
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
