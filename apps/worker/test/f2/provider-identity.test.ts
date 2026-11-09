import { deriveProviderUserId } from "@worker/infrastructure/auth/provider-identity";
import { describe, expect, it } from "vitest";

describe("provider user identity", () => {
	it("derives the approved service-scoped versioned digest", async () => {
		expect(
			await deriveProviderUserId("synthetic-owner", "https://service.test"),
		).toBe(
			"oab1_252cf1cfcb6ae44fe7490034d3993c274a0079f5d9e07cf1cc5477398ae1087d",
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
