import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("default-deny Worker entry point", () => {
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
