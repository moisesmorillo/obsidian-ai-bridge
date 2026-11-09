import { env, runInDurableObject, SELF } from "cloudflare:test";
import { MEASUREMENT_LIMITS } from "@vaultwire/protocol";
import type { ClientRegistryGateway } from "@worker/application/clients";
import { createOwnerHandler } from "@worker/transport/owner";
import { WORKER_VERSION } from "@worker/transport/owner-pages/version";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("production owner console", () => {
	it("denies callers without a verified Access identity", async () => {
		const response = await SELF.fetch("https://service.test/owner/clients");
		expect(response.status).toBe(401);
		const blobGc = await SELF.fetch("https://service.test/owner/blob-gc");
		expect(blobGc.status).toBe(401);
		expect(blobGc.headers.get("cache-control")).toBe("no-store");
		const measurements = await SELF.fetch(
			"https://service.test/owner/measurements",
		);
		expect(measurements.status).toBe(401);
		expect(measurements.headers.get("cache-control")).toBe("no-store");
		const html = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": "forged" } },
		);
		expect(html.status).toBe(401);
		expect(html.headers.get("cache-control")).toBe("no-store");
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
		const stub = env.VAULTS.get(env.VAULTS.idFromName(env.VAULT_OBJECT_NAME!));
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
		/** Sign an Access assertion to test owner and non-owner subjects against the same key. */
		const signAccessAssertion = (subject: string) =>
			new SignJWT({})
				.setProtectedHeader({ alg: "RS256", kid: "owner-console" })
				.setIssuer("https://team.test")
				.setAudience("synthetic-access-app")
				.setSubject(subject)
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(pair.privateKey);
		const assertion = await signAccessAssertion("synthetic-owner");
		const nonOwnerAssertion = await signAccessAssertion("different-subject");
		const nonOwnerMeasurements = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": nonOwnerAssertion } },
		);
		expect(nonOwnerMeasurements.status).toBe(401);
		expect(nonOwnerMeasurements.headers.get("cache-control")).toBe("no-store");
		const readMeasurements = vi.fn(async () => null);
		const ownerHandler = createOwnerHandler(
			() => {
				throw new Error("The registry resolver must not run");
			},
			() => ({ readMeasurements }),
		);
		const ownerFetch = ownerHandler.fetch;
		if (!ownerFetch) throw new Error("Owner handler has no fetch entry point");
		const nonOwnerRequest = new Request(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": nonOwnerAssertion } },
		) as Request<unknown, IncomingRequestCfProperties>;
		const blockedMeasurement = await ownerFetch(
			nonOwnerRequest,
			env,
			{} as ExecutionContext,
		);
		expect(blockedMeasurement.status).toBe(401);
		expect(readMeasurements).not.toHaveBeenCalled();
		const csrfRegistry = {
			storeOwnerCsrf: vi.fn(async () => undefined),
			consumeOwnerCsrf: vi.fn(async () => true),
		} as unknown as ClientRegistryGateway;
		const previewBlobGc = vi.fn(async () => ({ count: 2, bytes: 17 }));
		const statusBlobGc = vi.fn(async () => ({
			phase: "deleting" as const,
			marked_count: 1,
			marked_bytes: 9,
			delete_state: "unknown" as const,
			failure: null,
		}));
		const collectBlobGc = vi.fn(async () => ({
			phase: "marking" as const,
			marked_count: 1,
			marked_bytes: 9,
			delete_state: "idle" as const,
			failure: null,
		}));
		const gcHandler = createOwnerHandler(
			() => csrfRegistry,
			undefined,
			undefined,
			() => ({
				preview: previewBlobGc,
				status: statusBlobGc,
				collect: collectBlobGc,
			}),
		);
		if (!gcHandler.fetch)
			throw new Error("Owner GC handler has no fetch entry point");
		const gcResponse = await gcHandler.fetch(
			new Request("https://service.test/owner/blob-gc", {
				headers: { "Cf-Access-Jwt-Assertion": assertion },
			}) as Request<unknown, IncomingRequestCfProperties>,
			env,
			{} as ExecutionContext,
		);
		expect(gcResponse.status).toBe(200);
		const gcHtml = await gcResponse.text();
		expect(gcHtml).toContain("2 unreferenced blobs, under 0.1 MB reclaimable");
		expect(gcHtml).toContain("Delete outcome is unknown.");
		expect(gcHtml).toContain("An owner retry cannot clear this claim.");
		const state = gcHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
		const cookie = gcResponse.headers.get("set-cookie")?.split(";")[0];
		if (!state || !cookie) throw new Error("Owner GC form lacks CSRF state");
		const confirmed = await gcHandler.fetch(
			new Request("https://service.test/owner/blob-gc", {
				method: "POST",
				headers: {
					"Cf-Access-Jwt-Assertion": assertion,
					Origin: "https://service.test",
					Cookie: cookie,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ csrf: state }),
			}) as Request<unknown, IncomingRequestCfProperties>,
			env,
			{} as ExecutionContext,
		);
		expect(confirmed.status).toBe(303);
		expect(csrfRegistry.consumeOwnerCsrf).toHaveBeenCalledOnce();
		expect(collectBlobGc).toHaveBeenCalledWith("synthetic-owner");
		const response = await SELF.fetch("https://service.test/owner/clients", {
			headers: { "Cf-Access-Jwt-Assertion": assertion },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("/owner/measurements?format=html");
		expect(html).toContain(
			`<span class="label">Worker</span> ${WORKER_VERSION}</p>`,
		);
		const measurements = await SELF.fetch(
			"https://service.test/owner/measurements",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(measurements.status).toBe(200);
		expect(measurements.headers.get("cache-control")).toBe("no-store");
		expect(measurements.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await measurements.json()).toMatchObject({
			worker_isolate: {
				isolate_id: expect.any(String),
				active_slots: 0,
				available_slots: 12,
				limit: 12,
				expired_count: expect.any(Number),
				deadline_ms: 60_000,
			},
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
		const browserAccept =
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
		for (const [query, accept, expectedType] of [
			["", "text/html, application/json", "application/json"],
			["", browserAccept, "text/html"],
			["", "text/html/extra", "application/json"],
			["", "text/html;q=1=garbage", "application/json"],
			["", "text/html;q=0.1;q=0.9", "application/json"],
			["", "text/html;q=0.1234", "application/json"],
			["", "text/html;q=0.9, application/json;q=0.8", "text/html"],
			["", "text/html;q=0, application/json;q=1", "application/json"],
			["", "text/*;q=0.9, application/json;q=0.8", "text/html"],
			["", "text/html;q=0, */*;q=0.8", "application/json"],
			["", "application/json;q=0, */*;q=0.8", "text/html"],
			["", "text/html;q=2, application/json;q=0.8", "application/json"],
			["", "*/*", "application/json"],
			["?format=html", "text/html/extra", "text/html"],
			["?format=json", "text/html;q=1=garbage", "application/json"],
		] as const) {
			const negotiated = await SELF.fetch(
				`https://service.test/owner/measurements${query}`,
				{
					headers: {
						"Cf-Access-Jwt-Assertion": assertion,
						Accept: accept,
					},
				},
			);
			expect(negotiated.headers.get("content-type")).toContain(expectedType);
		}
		const emptySummary = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		const emptySummaryHtml = await emptySummary.text();
		expect(emptySummaryHtml).toContain(
			"Request observation window: Unknown to Unknown",
		);
		expect(emptySummaryHtml).toContain("No observed clients.");
		expect(emptySummaryHtml).toContain("Responding Worker isolate");
		expect(emptySummaryHtml).toContain("limit 12. Hold deadline: 60000 ms.");
		expect(emptySummaryHtml).toContain("Held 0 of 12");
		expect(emptySummaryHtml).toContain('aria-label="0 of 12 read slots held"');
		expect(emptySummaryHtml.match(/class="slot-segment"/g)).toHaveLength(12);
		expect(emptySummaryHtml).toContain(
			"does not describe other isolates or prove physical source work stopped.",
		);
		expect(emptySummaryHtml).toContain("Feed response preparation p95");
		expect(emptySummaryHtml).toContain("0 of 0");
		expect(emptySummaryHtml).toContain("Latency observation: unknown, stale.");
		expect(emptySummaryHtml).toContain("under 0.1 MB");
		expect(emptySummaryHtml).toContain(
			"Referenced R2 bytes count distinct blobs, not total bucket allocation.",
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
						client_id: "device-<script>",
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
		expect(summary.headers.get("content-type")).toContain("text/html");
		const summaryHtml = await summary.text();
		expect(summaryHtml).toContain("Feed response preparation p95");
		expect(summaryHtml).toContain("coverage partial");
		expect(summaryHtml).toContain("Observed lower bound. observed, stale.");
		expect(summaryHtml).toContain("Latency observation: observed, stale.");
		expect(summaryHtml).toContain("0.3 MB");
		expect(summaryHtml).toContain("Request observation window:");
		expect(summaryHtml).toContain("unknown (out-of-order requests)");
		expect(summaryHtml).toContain("device-&lt;script&gt;");
		expect(summaryHtml).toContain("Referenced R2 bytes count distinct blobs");
		expect(summaryHtml).not.toContain("device-<script>");
		expect(summaryHtml).toContain(
			`observed ${new Date(observedFrom).toISOString().slice(11, 16)} to`,
		);
		expect(summaryHtml).toContain("Retained sample window:");
		expect(summaryHtml).toContain(
			"Earlier samples were removed by the daily cap.",
		);
		const jsonLink = summaryHtml.match(
			/<a href="([^"]+)">Measurement JSON<\/a>/,
		);
		expect(jsonLink?.[1]).toBe("/owner/measurements?format=json");
		const linkedJson = await SELF.fetch(
			new URL(jsonLink?.[1] ?? "", "https://service.test"),
			{
				headers: {
					"Cf-Access-Jwt-Assertion": assertion,
					Accept: browserAccept,
				},
			},
		);
		expect(linkedJson.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(linkedJson.status).toBe(200);
		expect(jsonLink?.[1]).toBe("/owner/measurements?format=json");
		const canonicalJson = await SELF.fetch(
			"https://service.test/owner/measurements?format=json",
			{
				headers: {
					"Cf-Access-Jwt-Assertion": assertion,
					Accept: browserAccept,
				},
			},
		);
		expect(canonicalJson.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await linkedJson.json()).toEqual(await canonicalJson.json());

		await runInDurableObject(stub, (_instance, state) => {
			const aggregate = JSON.parse(
				state.storage.sql
					.exec<{ value: string }>(
						"SELECT value FROM meta WHERE key = ?",
						"service_measurements_v1",
					)
					.one().value,
			) as { coverage_incomplete: boolean };
			aggregate.coverage_incomplete = true;
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = ?",
				JSON.stringify(aggregate),
				"service_measurements_v1",
			);
		});
		const incompleteSummary = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(await incompleteSummary.text()).toContain("coverage unknown");

		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DROP TABLE files");
		});
		const unknownStorageSummary = await SELF.fetch(
			"https://service.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(await unknownStorageSummary.text()).toContain(
			"Unknown (storage_error)",
		);

		const wrongOrigin = await SELF.fetch(
			"https://other.test/owner/measurements?format=html",
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(wrongOrigin.status).toBe(404);
		expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
		expect(html).not.toContain("<script>unsafe()");
		expect(html).toContain("Revoked");
		expect(html).toContain("retained grant history");
		expect(html).toContain("Listed-page registry totals");
		expect(html).toContain("No grants");
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
		expect(grantHtml).toContain('<p class="label">Cleanup pending</p>');
		expect(grantHtml).toContain(">Pending</td>");
		expect(grantHtml).toContain(
			"Clients / &lt;script&gt;unsafe()&lt;/script&gt;",
		);
		expect(grantHtml).toContain('Kind</p><p class="stat-value">Unknown');
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

	it("lists, starts, streams, and explains when a completed archive is missing", async () => {
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
		const ownerEnv = {
			...env,
			ACCESS_TEAM_DOMAIN: `https://team-${crypto.randomUUID()}.test`,
		};
		const assertion = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "owner-console" })
			.setIssuer(ownerEnv.ACCESS_TEAM_DOMAIN)
			.setAudience("synthetic-access-app")
			.setSubject("synthetic-owner")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(pair.privateKey);
		const createdAt = "2026-11-07T03:00:00.000Z";
		const epoch = "a".repeat(32);
		const started = vi.fn(async (_owner: string, timestamp: string) => ({
			epoch,
			created_at: timestamp,
			status: "queued" as const,
			size: null,
			failure: null,
		}));
		let archiveAvailable = true;
		const download = vi.fn(async () => {
			if (!archiveAvailable) return null;
			return {
				body: new ReadableStream<Uint8Array>({
					/** Emit the fixed four-byte archive used by the download test. */
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3, 4]));
						controller.close();
					},
				}),
				size: 4,
			};
		});
		const csrfStates = new Map<string, { owner: string; browser: string }>();
		const registry = {
			/** Save one test CSRF state bound to its owner and browser. */
			async storeOwnerCsrf(input: {
				owner_subject: string;
				browser_id: string;
				state: string;
			}) {
				csrfStates.set(input.state, {
					owner: input.owner_subject,
					browser: input.browser_id,
				});
			},
			/** Consume only the exact saved owner, browser, and state tuple. */
			async consumeOwnerCsrf(input: {
				owner_subject: string;
				browser_id: string;
				state: string;
			}) {
				const saved = csrfStates.get(input.state);
				csrfStates.delete(input.state);
				return (
					saved?.owner === input.owner_subject &&
					saved.browser === input.browser_id
				);
			},
		} as unknown as ClientRegistryGateway;
		const handler = createOwnerHandler(
			() => registry,
			undefined,
			() => ({
				/** Return the requested idempotent test operation. */
				start: started,
				/** Return one completed row for owner snapshot rendering. */
				list: async () => [
					{
						epoch,
						created_at: createdAt,
						status: "complete",
						size: 4,
						failure: null,
					},
					{
						epoch,
						created_at: "2026-11-06T03:00:00.000Z",
						status: "failed",
						size: null,
						failure: { kind: "export_source_unavailable" },
					},
				],
				/** Return the bounded archive stream for the protected download test. */
				download,
			}),
		);
		const ownerFetch = handler.fetch;
		if (!ownerFetch) throw new Error("Owner handler has no fetch entry point");
		const headers = { "Cf-Access-Jwt-Assertion": assertion };
		const page = await ownerFetch(
			new Request("https://service.test/owner/exports", { headers }) as Request<
				unknown,
				IncomingRequestCfProperties
			>,
			ownerEnv,
			{} as ExecutionContext,
		);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");
		const html = await page.text();
		expect(html).toContain("Completed snapshots");
		expect(html).toContain("Failed exports");
		expect(html).toContain("export_source_unavailable");
		expect(html.match(/\/download/g)).toHaveLength(1);
		const downloadUrl = html.match(/href="([^"]+\/download)"/)?.[1];
		expect(downloadUrl).toContain("/owner/exports/");
		const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
		const state = html.match(/name="csrf" value="([^"]+)"/)?.[1];
		if (!cookie || !state)
			throw new Error("Owner export form lacks its browser state");
		const form = await ownerFetch(
			new Request("https://service.test/owner/exports", {
				method: "POST",
				headers: {
					...headers,
					cookie,
					origin: "https://service.test",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ csrf: state }),
			}) as Request<unknown, IncomingRequestCfProperties>,
			ownerEnv,
			{} as ExecutionContext,
		);
		expect(form.status).toBe(303);
		expect(started).toHaveBeenCalledWith(
			"synthetic-owner",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		);
		const response = await ownerFetch(
			new Request(new URL(downloadUrl ?? "", "https://service.test"), {
				headers,
			}) as Request<unknown, IncomingRequestCfProperties>,
			ownerEnv,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/zip");
		expect(response.headers.get("content-disposition")).toContain(
			"attachment;",
		);
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
			1, 2, 3, 4,
		]);
		expect(download).toHaveBeenCalledWith("synthetic-owner", epoch, createdAt);

		archiveAvailable = false;
		const unavailable = await ownerFetch(
			new Request(new URL(downloadUrl ?? "", "https://service.test"), {
				headers,
			}) as Request<unknown, IncomingRequestCfProperties>,
			ownerEnv,
			{} as ExecutionContext,
		);
		expect(unavailable.status).toBe(404);
		expect(await unavailable.text()).toContain(
			"This packed export is no longer available. Return to /owner/exports to create a new export.",
		);
		expect(unavailable.headers.get("cache-control")).toBe("no-store");
	});

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
