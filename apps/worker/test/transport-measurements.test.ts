import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import type { TextVaultGateway } from "@worker/application/text-files";
import { createWorker } from "@worker/transport/worker";
import { describe, expect, it } from "vitest";

const identity: AuthorizationContext = {
	client_id: "verified-device",
	grant_id: "verified-grant",
	scopes: ["vault:read"],
};

/** Build a read-only mock that returns an empty successful feed without producing its body. */
function emptyFeedGateway(): ReadVaultGateway {
	return {
		authorize: async () => ({
			ok: true,
			ticket: { id: "ticket-1", expires_at: 1_800_000_000_000 },
		}),
		finishAdmission: () => ({ ok: true }),
		readVault: async () => ({
			ok: true,
			body: {
				epoch: "0123456789abcdef0123456789abcdef",
				head_seq: 0,
				counts: { live: 0, deleted: 0 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				capacity: {
					database_bytes: 0,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: 0,
					referenced_blob_bytes: 0,
				},
				attention: [],
			},
		}),
		readBatch: async () => ({
			ok: true,
			body: { collection: "changes", rows: [] },
		}),
		readHistoryUpper: async () => ({
			ok: false,
			failure: { kind: "not_found" },
		}),
	};
}

describe("resource router measurement hooks", () => {
	it("records verified feed requests and successful preparation without reading lazy bodies", async () => {
		const requests: unknown[] = [];
		const samples: unknown[] = [];
		const pending: Promise<unknown>[] = [];
		let identityCalls = 0;
		let failMeasurements = false;
		const gateway = emptyFeedGateway();
		const app = createWorker(
			async () => {
				identityCalls += 1;
				return identity;
			},
			() =>
				gateway as TextVaultGateway &
					HistoryVaultGateway &
					ReadVaultGateway &
					SearchVaultGateway,
			() => ({}) as BlobContentStore,
			() => ({
				recordRequest: async (observation) => {
					if (failMeasurements) throw new Error("metrics storage unavailable");
					requests.push(observation);
				},
				recordFeedPreparation: async (observation) => {
					if (failMeasurements) throw new Error("metrics storage unavailable");
					samples.push(observation);
				},
			}),
		);
		const executionContext = {
			/** Collect background metric writes for deterministic assertions. */
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
			/** Match the required Worker execution context contract. */
			passThroughOnException() {},
		} as ExecutionContext;
		const response = await app.fetch(
			new Request(
				"https://service.test/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0",
			),
			{} as never,
			executionContext,
		);
		await Promise.all(pending);

		expect(response.status).toBe(200);
		expect(response.bodyUsed).toBe(false);
		expect(identityCalls).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			client_id: "verified-device",
			protocol: "rest",
			feed_request: true,
		});
		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({
			client_id: "verified-device",
			duration_ms: expect.any(Number),
		});

		const failedRequest = await app.fetch(
			new Request("https://service.test/v1/changes?invalid=1"),
			{} as never,
			executionContext,
		);
		await Promise.all(pending);
		expect(failedRequest.status).toBe(400);
		expect(requests).toHaveLength(2);
		expect(samples).toHaveLength(1);

		const excludedOwnerRequest = await app.fetch(
			new Request("https://service.test/owner/measurements"),
			{} as never,
			executionContext,
		);
		expect(excludedOwnerRequest.status).toBe(404);
		expect(identityCalls).toBe(2);
		expect(requests).toHaveLength(2);

		const mcpRequest = await app.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "invalid",
			}),
			{} as never,
			executionContext,
		);
		await Promise.all(pending);
		expect(mcpRequest.status).toBeGreaterThanOrEqual(400);
		expect(requests).toHaveLength(3);
		expect(requests[2]).toMatchObject({ protocol: "mcp", feed_request: false });
		expect(samples).toHaveLength(1);

		failMeasurements = true;
		const validWithFailedMetrics = await app.fetch(
			new Request(
				"https://service.test/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0",
			),
			{} as never,
			executionContext,
		);
		await Promise.all(pending);
		expect(validWithFailedMetrics.status).toBe(200);
		expect(validWithFailedMetrics.bodyUsed).toBe(false);
	});
});
