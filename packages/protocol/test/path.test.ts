import { normalizePath, PathSchema, pathKey } from "@protocol/index";
import { describe, expect, it } from "vitest";

describe("path identity", () => {
	it("normalizes Unicode to NFC and preserves casing", () => {
		expect(normalizePath("Notes/cafe\u0301.md")).toBe("Notes/café.md");
	});

	it("uses Unicode lowercase only for the path key", () => {
		expect(pathKey("Notes/CAFÉ.md")).toBe("notes/café.md");
	});

	it("enforces the UTF-8 byte limit after normalization", () => {
		expect(PathSchema.safeParse(`${"a".repeat(509)}.md`).success).toBe(true);
		expect(PathSchema.safeParse(`${"a".repeat(510)}.md`).success).toBe(false);
		expect(PathSchema.safeParse(`${"é".repeat(255)}.md`).success).toBe(false);
	});

	it("enforces the segment limit", () => {
		expect(PathSchema.safeParse(Array(32).fill("a").join("/")).success).toBe(
			true,
		);
		expect(PathSchema.safeParse(Array(33).fill("a").join("/")).success).toBe(
			false,
		);
	});

	it.each([
		"",
		"/a.md",
		"a//b.md",
		"a/./b.md",
		"a/../b.md",
		"a\\b.md",
		"a/",
		"a\0b",
		"a\u007fb",
		"a\u0085b",
	])("rejects invalid path %j", (path) => {
		expect(PathSchema.safeParse(path).success).toBe(false);
	});
});
