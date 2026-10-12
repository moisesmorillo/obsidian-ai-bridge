import { SELF } from "cloudflare:test";
import worker from "@worker/index";
import { describe, expect, it } from "vitest";

describe("default-deny Worker entry point", () => {
	it("resolves the private workspace alias to the default-deny handler", async () => {
		const response = await worker.fetch(
			new Request("https://worker.invalid/unknown"),
		);

		expect(response.status).toBe(404);
	});

	it.each([
		["GET", "/v1/vault"],
		["GET", "/mcp"],
		["GET", "/owner/clients"],
		["GET", "/unknown"],
		["PUT", "/v1/files/Test.md"],
	] as const)("returns 404 for %s %s", async (method, path) => {
		const response = await SELF.fetch(`https://worker.invalid${path}`, {
			method,
			...(method === "PUT" ? { body: "content" } : {}),
		});

		expect(response.status).toBe(404);
	});
});
