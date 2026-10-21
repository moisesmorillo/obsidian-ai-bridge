import {
	BlobAuthorizationResultSchema,
	BlobDeclarationHeadersSchema,
	BlobDeclarationSchema,
	BlobMetadataSchema,
	selectByteRange,
} from "@protocol/schemas/blobs";
import { describe, expect, it } from "vitest";

describe("blob protocol contracts", () => {
	it("parses paired declaration headers and preserves undeclared inline requests", () => {
		expect(BlobDeclarationHeadersSchema.parse({})).toBeUndefined();
		expect(
			BlobDeclarationHeadersSchema.parse({
				"x-content-sha256": "a".repeat(64),
				"x-content-size": "25000000",
			}),
		).toEqual({ payload_hash: "a".repeat(64), size: 25_000_000 });
		for (const headers of [
			{ "x-content-sha256": "a".repeat(64) },
			{ "x-content-size": "1" },
			{ "x-content-sha256": "a".repeat(64), "x-content-size": "01" },
			{ "x-content-sha256": "a".repeat(64), "x-content-size": "+1" },
			{ "x-content-sha256": "a".repeat(64), "x-content-size": "25000001" },
		]) {
			expect(BlobDeclarationHeadersSchema.safeParse(headers).success).toBe(
				false,
			);
		}
	});

	it("validates digest and canonical declaration sizes", () => {
		for (const payload_hash of [
			"A".repeat(64),
			"g".repeat(64),
			"a".repeat(63),
		]) {
			expect(
				BlobDeclarationSchema.safeParse({ payload_hash, size: 0 }).success,
			).toBe(false);
		}
		for (const size of [0, 1_000_000, 1_000_001, 25_000_000]) {
			expect(
				BlobDeclarationSchema.safeParse({ payload_hash: "a".repeat(64), size })
					.success,
			).toBe(true);
		}
		for (const size of [-1, 1.5, 25_000_001, Number.MAX_SAFE_INTEGER + 1]) {
			expect(
				BlobDeclarationSchema.safeParse({ payload_hash: "a".repeat(64), size })
					.success,
			).toBe(false);
		}
	});

	it("enforces blob metadata and large-file semantics", () => {
		const base = {
			path: "notes/a.md",
			etag: `"${"a".repeat(31)}b.1"`,
			hash: "a".repeat(64),
			size: 1_000_001,
			kind: "blob",
			deleted: false,
			origin: "client",
			updated_at: 1,
		};
		expect(BlobMetadataSchema.safeParse({ ...base, large: true }).success).toBe(
			true,
		);
		expect(
			BlobMetadataSchema.safeParse({ ...base, large: false }).success,
		).toBe(false);
		expect(
			BlobMetadataSchema.safeParse({ ...base, path: "a.png", large: true })
				.success,
		).toBe(false);
		expect(
			BlobMetadataSchema.safeParse({
				...base,
				hash: "",
				size: 0,
				deleted: true,
				large: false,
			}).success,
		).toBe(true);
	});

	it("selects one satisfiable byte range within the response budget", () => {
		expect(selectByteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
		for (const range of [
			"bytes=0-1000000",
			"bytes=1-2,4-5",
			"items=1-2",
			"bytes=8-3",
			"bytes=10-",
			"bytes=01-2",
		])
			expect(
				selectByteRange(range, range === "bytes=0-1000000" ? 2_000_000 : 10),
			).toBeUndefined();
		expect(selectByteRange("bytes=0-", 1_000_001)).toEqual({
			start: 0,
			end: 999_999,
		});
	});
	it("preserves canonical size-overflow issues for HTTP error selection", () => {
		for (const size of ["25000001", "9".repeat(400)]) {
			const result = BlobDeclarationHeadersSchema.safeParse({
				"x-content-sha256": "a".repeat(64),
				"x-content-size": size,
			});
			expect(result.success).toBe(false);
			if (result.success) throw new Error("Expected declared overflow");
			expect(
				result.error.issues.every(
					(issue) => issue.code === "too_big" && issue.path[0] === "size",
				),
			).toBe(true);
		}
	});
	it("accepts ticket or receipt authority results without a second upload contract", () => {
		expect(
			BlobAuthorizationResultSchema.safeParse({
				ok: true,
				ticket: { id: "a".repeat(32), expires_at: 60_000 },
			}).success,
		).toBe(true);
		expect(
			BlobAuthorizationResultSchema.safeParse({
				ok: false,
				failure: { kind: "revoked" },
			}).success,
		).toBe(true);
		expect(
			BlobAuthorizationResultSchema.safeParse({
				ok: true,
				response: {
					status: 201,
					body: {
						path: "file.bin",
						etag: '"0123456789abcdef0123456789abcdef.1"',
						seq: 1,
						hash: "a".repeat(64),
						size: 0,
						deleted: false,
					},
				},
			}).success,
		).toBe(true);
		expect(BlobAuthorizationResultSchema.safeParse({ ok: true }).success).toBe(
			false,
		);
	});
});
