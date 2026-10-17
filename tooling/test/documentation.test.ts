import { checkDocumentation } from "@tooling/documentation";
import { describe, expect, it } from "vitest";

describe("declaration documentation", () => {
	it.each([
		["function", "export function decode() {}"],
		["internal function", "function decode() {}"],
		["function binding", "const decode = () => 1;"],
		[
			"nested function binding",
			"items.map(() => { const decode = () => 1; return decode(); });",
		],
		["private method", "/** Owns persistence. */ class Store { #commit() {} }"],
		[
			"protected method",
			"/** Owns persistence. */ class Store { protected commit() {} }",
		],
		[
			"accessor",
			"/** Owns persistence. */ class Store { get value() { return 1; } }",
		],
		[
			"constructor",
			"/** Owns persistence. */ class Store { constructor() { connect(); } }",
		],
		["interface", "interface Receipt { revision: number }"],
		["type", "type Receipt = { revision: number };"],
		["enum", "enum Phase { Ready }"],
		["schema", "const StateSchema = z.object({});"],
		["constant object", "const POLICY = { retry: false };"],
		["exported binding", "export const schema = sqliteTable('meta', {});"],
		["object method", "const adapter = { commit() {} };"],
	])("rejects an undocumented %s", (_kind, source) => {
		expect(checkDocumentation("fixture.ts", source)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "missing", path: "fixture.ts" }),
			]),
		);
	});

	it.each([
		"/** Persists one transaction without repair. */ export function commit() {}",
		"/** Persists one transaction without repair. */ const commit = () => 1;",
		"/** Owns persistence. */ class Store { /** Delegates transaction admission. */ #commit() {} }",
		"/** Owns persistence. */ class Store { /** Opens the store once. */ constructor() { connect(); } }",
		"/** Validates the persistence boundary. */ const StateSchema = z.object({});",
		"items.map((item) => item.name); const count = 1; const { id } = source;",
		"import { decode } from 'codec'; export { decode };",
		"const adapter = { retry: false };",
	])("accepts documented declarations or explicit exemptions: %s", (source) => {
		expect(checkDocumentation("fixture.ts", source)).toEqual([]);
	});

	it("does not attach an earlier declaration comment to the next declaration", () => {
		expect(
			checkDocumentation(
				"fixture.ts",
				"/** Owns admission. */ function first() {}\nfunction second() {}",
			),
		).toEqual([
			expect.objectContaining({
				declaration: "second",
				rule: "missing",
				line: 2,
			}),
		]);
	});
	it("rejects empty comments", () => {
		expect(
			checkDocumentation("fixture.ts", "/** */ function commit() {}"),
		).toEqual([expect.objectContaining({ rule: "empty" })]);
	});
	it("reports malformed TSDoc with its source line", () => {
		expect(
			checkDocumentation(
				"fixture.ts",
				"/** Calls {@link } before commit. */\nfunction commit() {}",
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "tsdoc", line: 1 }),
			]),
		);
	});
	it("checks TSDoc blocks even when they precede an ordinary binding", () => {
		expect(
			checkDocumentation(
				"fixture.ts",
				"/** Calls {@link }. */ const count = 1;",
			),
		).toEqual(
			expect.arrayContaining([expect.objectContaining({ rule: "tsdoc" })]),
		);
	});
	it("rejects malformed TypeScript rather than accepting a partial inventory", () => {
		expect(checkDocumentation("fixture.ts", "export function ( {")).toEqual(
			expect.arrayContaining([expect.objectContaining({ rule: "syntax" })]),
		);
	});
	it("excludes only the known generated module", () => {
		expect(
			checkDocumentation(
				"apps/worker/src/infrastructure/sqlite/schema.generated.ts",
				"export const schema = [];",
			),
		).toEqual([]);
		expect(
			checkDocumentation("other.generated.ts", "export function decode() {}"),
		).toEqual([expect.objectContaining({ rule: "missing" })]);
	});
	it("keeps Unicode before a comment from shifting its declaration attachment", () => {
		expect(
			checkDocumentation(
				"fixture.ts",
				'const label = "café";\n/** Preserves the observed revision. */\nfunction commit() {}',
			),
		).toEqual([]);
	});
});
