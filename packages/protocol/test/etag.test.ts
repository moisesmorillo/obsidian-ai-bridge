import { formatETag, parseETag } from "@protocol/index";
import { describe, expect, it } from "vitest";

const epoch = "e".repeat(32);

describe("ETag identity", () => {
	it("round-trips a quoted epoch and positive revision", () => {
		expect(formatETag(epoch, 1)).toBe(`"${epoch}.1"`);
		expect(parseETag(`"${epoch}.1"`)).toEqual({ epoch, rev: 1 });
	});

	it.each([
		`${epoch}.1`,
		`"${"1".repeat(32)}.1"`,
		`"${"g".repeat(32)}.1"`,
		`"${"e".repeat(31)}.1"`,
		`"${epoch}.0"`,
		`"${epoch}.-1"`,
		`"${epoch}.1.5"`,
		`"${epoch}.9007199254740992"`,
	])("rejects invalid ETag %j", (etag) => {
		expect(() => parseETag(etag)).toThrow();
	});

	it("rejects invalid generation and revision arguments during formatting", () => {
		expect(() => formatETag("1".repeat(32), 1)).toThrow();
		for (const rev of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => formatETag(epoch, rev)).toThrow();
		}
	});
});
