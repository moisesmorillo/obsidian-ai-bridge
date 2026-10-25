import { env, SELF } from "cloudflare:test";
import worker from "@worker/index";
import { describe, expect, it } from "vitest";

describe("production entry without OAuth configuration", () => {
	it("resolves the private workspace alias to the default-deny handler", async () => {
		const response = await worker.fetch(
			new Request("https://worker.invalid/unknown"),
		);

		expect(response.status).toBe(404);
	});

	it("denies MCP traffic when OAuth configuration is unavailable", async () => {
		const response = await SELF.fetch("https://worker.invalid/mcp", {
			method: "GET",
		});

		expect(response.status).toBe(503);
	});

	it.each([
		["GET", "/owner/clients"],
		["GET", "/unknown"],
	] as const)(
		"denies %s %s when OAuth configuration is unavailable",
		async (method, path) => {
			const response = await SELF.fetch(`https://worker.invalid${path}`, {
				method,
			});

			expect(response.status).toBe(503);
		},
	);

	it.each([
		"/v1/vault",
		"/v1/manifest",
		"/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0",
		"/v1/history/note.md",
		"/v1/search?q=abc",
		"/v1/files/note.md",
		"/v1/files/note.md?rev=1",
	])("denies production read %s before Vault selection", async (route) => {
		const response = await SELF.fetch(`https://worker.invalid${route}`);
		expect(response.status).toBe(503);
	});

	it("denies a registered production file route before body processing", async () => {
		const request = new Request("https://worker.invalid/v1/files/Private.md", {
			method: "PUT",
			headers: {
				"X-Test-Identity": "write",
				"X-Client-Id": "forged-client",
				"If-None-Match": "*",
				"X-Vault-Epoch": "0123456789abcdef0123456789abcdef",
			},
			body: "must not reach a Vault",
		});
		const response = await worker.fetch(request, env);
		expect(response.status).toBe(503);
		expect(request.bodyUsed).toBe(false);
	});
});
