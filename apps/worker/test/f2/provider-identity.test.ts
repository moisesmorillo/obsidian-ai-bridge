import { deriveProviderUserId } from "@worker/infrastructure/auth/provider-identity";
import { describe, expect, it } from "vitest";

describe("provider user identity", () => {
	it("derives the approved service-scoped versioned digest", async () => {
		expect(
			await deriveProviderUserId("synthetic-owner", "https://service.test"),
		).toBe(
			"oab1_e3bc591b296bb542e961d30e2f77415a1cb4b97ed607ed0575fdf5afe91ce653",
		);
	});

	it("maps the same owner consistently and separates subjects and origins", async () => {
		const original = await deriveProviderUserId(
			"synthetic-owner",
			"https://service.test",
		);
		expect(
			await deriveProviderUserId("synthetic-owner", "https://service.test"),
		).toBe(original);
		expect(
			await deriveProviderUserId("synthetic-other", "https://service.test"),
		).not.toBe(original);
		expect(
			await deriveProviderUserId("synthetic-owner", "https://other.test"),
		).not.toBe(original);
		expect(original).toMatch(/^oab1_[0-9a-f]{64}$/);
		expect(original).not.toContain(":");
		expect(original).not.toContain("synthetic-owner");
	});
});
