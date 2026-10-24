import { env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("production owner console", () => {
	it("denies callers without a verified Access identity", async () => {
		const response = await SELF.fetch("https://service.test/owner/clients");
		expect(response.status).toBe(401);
	});

	it("renders escaped names from the durable registry for verified owner Access", async () => {
		const pair = await generateKeyPair("RS256");
		const jwk = await exportJWK(pair.publicKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					keys: [{ ...jwk, kid: "owner-console", alg: "RS256", use: "sig" }],
				}),
			),
		);
		const clientId = `owner-${crypto.randomUUID()}`;
		const stub = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
		await stub.beginClientConsent(
			"synthetic-owner",
			clientId,
			"<script>unsafe()</script>",
		);
		const assertion = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "owner-console" })
			.setIssuer("https://team.test")
			.setAudience("synthetic-access-app")
			.setSubject("synthetic-owner")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(pair.privateKey);
		const response = await SELF.fetch("https://service.test/owner/clients", {
			headers: { "Cf-Access-Jwt-Assertion": assertion },
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
		expect(html).not.toContain("<script>unsafe()");
		const oversized = await SELF.fetch(
			"https://service.test/owner/clients/unused/rename",
			{
				method: "POST",
				headers: {
					"Cf-Access-Jwt-Assertion": assertion,
					"content-type": "application/x-www-form-urlencoded",
					origin: "https://service.test",
				},
				body: new URLSearchParams({ csrf: "a".repeat(5_000), name: "test" }),
			},
		);
		expect(oversized.status).toBe(400);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("rejects state changes from a different origin before processing the form", async () => {
		const response = await SELF.fetch(
			"https://service.test/owner/clients/fake/revoke",
			{
				method: "POST",
				headers: {
					origin: "https://attacker.test",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: "csrf=fake",
			},
		);
		expect(response.status).toBe(403);
	});
});
