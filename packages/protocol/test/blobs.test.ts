import {
	BlobDeclarationSchema,
	BlobMetadataSchema,
	selectByteRange,
} from "@protocol/schemas/blobs";
import { describe, expect, it } from "vitest";

describe("blob protocol contracts", () => {
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
});
