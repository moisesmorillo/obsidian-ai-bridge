import type {
	AuthorizationContext,
	MeasurementAggregate,
} from "@vaultwire/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import {
	createMeasurementGateway,
	type MeasurementStore,
} from "@worker/application/measurements";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import type { TextVaultGateway } from "@worker/application/text-files";
import { createWorker } from "@worker/transport/worker";
import { describe, expect, it, vi } from "vitest";

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
	it("preserves request totals when the later feed RPC writes first", async () => {
		const requestAt = 1_700_000_000_000;
		const sampleAt = requestAt + 20;
		let clockCalls = 0;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => (clockCalls++ === 0 ? requestAt : sampleAt));
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Apply the same no-op rule as the transactional SQLite adapter. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const application = createMeasurementGateway(store, () => sampleAt + 1);
		/** Signal that transport started the delayed request RPC. */
		let beginRequestWrite: () => void = () => undefined;
		/** Apply the delayed request observation after the feed observation. */
		let releaseRequestWrite: () => void = () => undefined;
		/** Signal that the successful feed sample reached durable application state. */
		let markSampleWritten: () => void = () => undefined;
		const requestWriteStarted = new Promise<void>((resolve) => {
			beginRequestWrite = resolve;
		});
		const sampleWritten = new Promise<void>((resolve) => {
			markSampleWritten = resolve;
		});
		const pending: Promise<unknown>[] = [];
		const readGateway = emptyFeedGateway();
		const app = createWorker(
			async () => identity,
			() =>
				readGateway as TextVaultGateway &
					HistoryVaultGateway &
					ReadVaultGateway &
					SearchVaultGateway,
			() => ({}) as BlobContentStore,
			() => ({
				/** Delay request persistence until the test observes the feed write. */
				recordRequest(observation) {
					return new Promise<void>((resolve) => {
						beginRequestWrite();
						releaseRequestWrite = () => {
							application.recordRequest(observation);
							resolve();
						};
					});
				},
				/** Persist the feed sample before releasing the delayed request write. */
				recordFeedPreparation(observation) {
					application.recordFeedPreparation(observation);
					markSampleWritten();
				},
			}),
		);
		const executionContext = {
			/** Retain background RPCs until the test chooses their settlement order. */
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
			/** Match the required Worker execution context contract. */
			passThroughOnException() {},
		} as ExecutionContext;

		try {
			const response = await app.fetch(
				new Request(
					"https://service.test/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0",
				),
				{} as never,
				executionContext,
			);
			await requestWriteStarted;
			await sampleWritten;
			expect(response.status).toBe(200);
			expect(response.bodyUsed).toBe(false);
			expect(state.value?.requests_rest).toBe(0);
			releaseRequestWrite();
			await Promise.all(pending);
			expect(state.value?.requests_rest).toBe(1);
			expect(state.value?.observed_through).toBe(sampleAt);
			expect(state.value?.request_observed_through).toBe(requestAt);
		} finally {
			clock.mockRestore();
		}
	});

	it("does not record a zero latency sample after wall-clock rollback", async () => {
		const clockValues = [1_700_000_000_000, 1_699_999_999_000];
		const rollbackTime = clockValues[1];
		if (rollbackTime === undefined) throw new Error("Expected rollback time");
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => clockValues.shift() ?? rollbackTime);
		const samples: unknown[] = [];
		const pending: Promise<unknown>[] = [];
		const gateway = emptyFeedGateway();
		const app = createWorker(
			async () => identity,
			() =>
				gateway as TextVaultGateway &
					HistoryVaultGateway &
					ReadVaultGateway &
					SearchVaultGateway,
			() => ({}) as BlobContentStore,
			() => ({
				recordRequest: () => undefined,
				/** Collect only feed samples accepted by the clock boundary. */
				recordFeedPreparation(observation) {
					samples.push(observation);
				},
			}),
		);
		const executionContext = {
			/** Retain background metric writes until the test checks the result. */
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
			/** Match the required Worker execution context contract. */
			passThroughOnException() {},
		} as ExecutionContext;

		try {
			const response = await app.fetch(
				new Request(
					"https://service.test/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0",
				),
				{} as never,
				executionContext,
			);
			await Promise.all(pending);

			expect(response.status).toBe(200);
			expect(samples).toHaveLength(0);
		} finally {
			clock.mockRestore();
		}
	});

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
