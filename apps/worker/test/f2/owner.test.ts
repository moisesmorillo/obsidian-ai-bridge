import { env, runInDurableObject, SELF } from "cloudflare:test";
import { MEASUREMENT_LIMITS } from "@obsidian-ai-bridge/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("production owner console", () => {
	it("denies callers without a verified Access identity", async () => {
		const response = await SELF.fetch("https://service.test/owner/clients");
		expect(response.status).toBe(401);
		const measurements = await SELF.fetch(
			"https://service.test/owner/measurements",
		);
		expect(measurements.status).toBe(401);
		expect(measurements.headers.get("cache-control")).toBe("no-store");
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
		const consent = await stub.beginClientConsent(
			"synthetic-owner",
			clientId,
			"<script>unsafe()</script>",
		);
		const grantId = `grant-${crypto.randomUUID()}`;
		expect(
			await stub.registerClientGrant({
				owner_subject: "synthetic-owner",
				client_id: clientId,
				grant_id: grantId,
				generation: consent.generation,
				consent_id: consent.consent_id,
			}),
		).toBe(true);
		await stub.revokeClient("synthetic-owner", clientId);
		const mixedClientId = `mixed-${crypto.randomUUID()}`;
		const firstConsent = await stub.beginClientConsent(
			"synthetic-owner",
			mixedClientId,
			"Mixed history client",
		);
		await stub.registerClientGrant({
			owner_subject: "synthetic-owner",
			client_id: mixedClientId,
			grant_id: `grant-old-${crypto.randomUUID()}`,
			generation: firstConsent.generation,
			consent_id: firstConsent.consent_id,
		});
		await stub.revokeClient("synthetic-owner", mixedClientId);
		const secondConsent = await stub.beginClientConsent(
			"synthetic-owner",
			mixedClientId,
			"Mixed history client",
		);
		await stub.registerClientGrant({
			owner_subject: "synthetic-owner",
			client_id: mixedClientId,
			grant_id: `grant-new-${crypto.randomUUID()}`,
			generation: secondConsent.generation,
			consent_id: secondConsent.consent_id,
		});
		const ungrantedClientId = `ungranted-${crypto.randomUUID()}`;
		await stub.beginClientConsent(
			"synthetic-owner",
			ungrantedClientId,
			"No grant client",
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
		const measurements = await SELF.fetch(
			"https://service.test/owner/measurements",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(measurements.status).toBe(200);
		expect(measurements.headers.get("cache-control")).toBe("no-store");
		expect(await measurements.json()).toMatchObject({
			status: "unknown",
			coverage: "unknown",
			requests: {
				status: "unknown",
				count: null,
				observed_from: null,
				observed_through: null,
			},
			feed_latency: { status: "unknown", p95: null },
			storage: {
				database_bytes: { status: "observed" },
				referenced_blob_bytes: { status: "observed", value: 0 },
			},
		});
		const emptySummary = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(await emptySummary.text()).toContain(
			"Request observation window: unknown to unknown",
		);
		const observedFrom = 1_700_006_400_100;
		const requestObservedAt = 1_700_006_400_101;
		const firstRetainedSampleAt = 1_700_006_400_102;
		const retainedSampleCount = MEASUREMENT_LIMITS.latencySamples;
		const lastRetainedSampleAt =
			firstRetainedSampleAt + retainedSampleCount - 1;
		await runInDurableObject(stub, (_instance, state) => {
			const aggregate = {
				version: 1,
				day_start: 1_700_006_400_000,
				day_end: 1_700_092_800_000,
				observed_from: observedFrom,
				observed_through: lastRetainedSampleAt,
				request_observed_from: requestObservedAt,
				request_observed_through: requestObservedAt,
				coverage_incomplete: false,
				requests_rest: 1,
				requests_mcp: 0,
				clients: [
					{
						client_id: "device-reordered",
						requests_rest: 1,
						requests_mcp: 0,
						last_feed_request_at: requestObservedAt,
						minimum_poll_interval_ms: null,
						maximum_poll_interval_ms: null,
						poll_cadence_incomplete: true,
					},
				],
				latency_total_samples: retainedSampleCount + 2,
				latency_samples: Array.from(
					{ length: retainedSampleCount },
					(_, index) => ({
						observed_at: firstRetainedSampleAt + index,
						duration_ms: index + 1,
					}),
				),
			};
			state.storage.sql.exec(
				"INSERT INTO meta (key, value) VALUES (?, ?)",
				"service_measurements_v1",
				JSON.stringify(aggregate),
			);
		});
		const summary = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(summary.headers.get("cache-control")).toBe("no-store");
		const summaryHtml = await summary.text();
		expect(summaryHtml).toContain("Feed response preparation p95");
		expect(summaryHtml).toContain(
			`Request observation window: ${new Date(requestObservedAt).toISOString()} to ${new Date(requestObservedAt).toISOString()}`,
		);
		expect(summaryHtml).toContain("unknown (out-of-order requests)");
		expect(summaryHtml).toContain(
			`Observed from ${new Date(observedFrom).toISOString()}`,
		);
		expect(summaryHtml).toContain(
			`Retained sample window: ${new Date(firstRetainedSampleAt).toISOString()} to ${new Date(lastRetainedSampleAt).toISOString()}`,
		);
		expect(summaryHtml).toContain(
			"Earlier samples were removed by the daily cap.",
		);
		const wrongOrigin = await SELF.fetch(
			"https://other.test/owner/measurements",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(wrongOrigin.status).toBe(404);
		expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
		expect(html).not.toContain("<script>unsafe()");
		expect(html).toContain("Revoked");
		expect(html).toContain("retained grant history");
		expect(html).toContain("Mixed active and revoked history");
		expect(html).toContain("No accepted grants");
		expect(html).not.toContain("synthetic-owner");
		expect(html).not.toContain("access_token");
		expect(html).not.toContain("refresh_token");
		expect(html).not.toContain("client_secret");
		expect(html).not.toContain("Set-Cookie");
		const grantsResponse = await SELF.fetch(
			`https://service.test/owner/clients/${encodeURIComponent(clientId)}/grants`,
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		const grantHtml = await grantsResponse.text();
		expect(grantHtml).toContain(grantId);
		expect(grantHtml).toContain("Revoked");
		expect(grantHtml).toContain("provider cleanup pending");
		expect(grantHtml).not.toContain("synthetic-owner");
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
