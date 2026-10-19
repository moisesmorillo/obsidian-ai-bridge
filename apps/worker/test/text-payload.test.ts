import { assertIdempotencyWindow } from "@worker/application/idempotency";
import { prepareTextPayload } from "@worker/application/text-payload";
import { describe, expect, it } from "vitest";

const now = Date.UTC(2026, 9, 18, 12, 0, 0);

/** Creates a UUIDv7 fixture with the given Unix-millisecond timestamp. */
function uuidV7At(timestamp: number): string {
	const hex = timestamp.toString(16).padStart(12, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
}

describe("idempotency time window", () => {
	it.each([now - 26 * 86_400_000, now + 10 * 60_000])(
		"rejects out-of-window UUIDv7 timestamp %s",
		(timestamp) => {
			expect(() =>
				assertIdempotencyWindow(uuidV7At(timestamp), now),
			).toThrowError(
				expect.objectContaining({ failure: { kind: "operation_expired" } }),
			);
		},
	);

	it("accepts opaque keys without a UUID timestamp window", () => {
		expect(() => assertIdempotencyWindow("Opaque-Key_123", now)).not.toThrow();
	});

	it.each([now - 25 * 86_400_000, now + 5 * 60_000, now + 4 * 60_000])(
		"accepts in-window UUIDv7 timestamp %s",
		(timestamp) => {
			expect(() =>
				assertIdempotencyWindow(uuidV7At(timestamp), now),
			).not.toThrow();
		},
	);
});

describe("text payload preparation", () => {
	it.each([
		[
			"ASCII",
			new TextEncoder().encode("hello"),
			"hello",
			5,
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		],
		[
			"non-ASCII",
			new TextEncoder().encode("café"),
			"café",
			5,
			"850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e",
		],
		[
			"BOM",
			new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
			"\uFEFFa",
			4,
			"1951c7860e968e742658b3af34e60741eb4aaf2a8d2ecc3993727016b12e81e8",
		],
		[
			"NUL",
			new Uint8Array([0x61, 0x00, 0x62]),
			"a\u0000b",
			3,
			"59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138",
		],
		[
			"empty",
			new Uint8Array(),
			"",
			0,
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		],
	] as const)(
		"uses original bytes for %s",
		async (_name, bytes, content, size, hash) => {
			await expect(prepareTextPayload(bytes)).resolves.toEqual({
				content,
				payload_hash: hash,
				size,
			});
		},
	);

	it("rejects invalid UTF-8 without replacement", async () => {
		await expect(
			prepareTextPayload(new Uint8Array([0xc3, 0x28])),
		).rejects.toMatchObject({
			failure: { kind: "invalid_request" },
		});
	});

	it("preserves original size and hash if the input buffer detaches during hashing", async () => {
		const buffer = new ArrayBuffer(5);
		const bytes = new Uint8Array(buffer);
		bytes.set(new TextEncoder().encode("hello"));

		const result = prepareTextPayload(bytes);
		structuredClone(buffer, { transfer: [buffer] });
		expect(buffer.byteLength).toBe(0);
		await expect(result).resolves.toEqual({
			content: "hello",
			payload_hash:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			size: 5,
		});
	});

	it("accepts exactly one million bytes", async () => {
		const boundary = new Uint8Array(1_000_000).fill(0x61);
		await expect(prepareTextPayload(boundary)).resolves.toMatchObject({
			size: 1_000_000,
		});
	});

	it("rejects payloads larger than one million bytes", async () => {
		await expect(
			prepareTextPayload(new Uint8Array(1_000_001).fill(0x61)),
		).rejects.toMatchObject({
			failure: { kind: "text_too_large" },
		});
	});
});
