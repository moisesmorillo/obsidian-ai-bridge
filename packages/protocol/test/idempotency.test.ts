import { IdempotencyKeySchema } from "@protocol/schemas/idempotency";
import { describe, expect, it } from "vitest";

describe("idempotency key schema", () => {
	it.each(["Opaque-Key_123", "x".repeat(8), "x".repeat(128)])(
		"accepts the exact key spelling for %s",
		(key) => {
			const parsed = IdempotencyKeySchema.safeParse(key);
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(parsed.data).toBe(key);
		},
	);

	it("accepts 128 Unicode code points and preserves the key", () => {
		const key = "😀".repeat(128);
		const parsed = IdempotencyKeySchema.safeParse(key);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toBe(key);
	});

	it("rejects four Unicode code points", () => {
		expect(IdempotencyKeySchema.safeParse("😀".repeat(4)).success).toBe(false);
	});

	it("rejects 129 Unicode code points", () => {
		expect(IdempotencyKeySchema.safeParse("😀".repeat(129)).success).toBe(
			false,
		);
	});

	it.each(["short", "x".repeat(129)])("rejects key %s", (key) => {
		expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
	});
});
