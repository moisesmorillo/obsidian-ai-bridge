import {
	type MeasurementAggregate,
	MeasurementAggregateSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	createMeasurementGateway,
	MEASUREMENT_LIMITS,
	type MeasurementStore,
	measurementResponse,
} from "@worker/application/measurements";
import { describe, expect, it } from "vitest";

const aggregate: MeasurementAggregate = MeasurementAggregateSchema.parse({
	version: 1,
	day_start: 1_700_006_400_000,
	day_end: 1_700_092_800_000,
	observed_from: 1_700_006_400_000,
	observed_through: 1_700_006_400_100,
	request_observed_from: 1_700_006_400_000,
	request_observed_through: 1_700_006_400_100,
	coverage_incomplete: false,
	requests_rest: 2,
	requests_mcp: 0,
	clients: [
		{
			client_id: "device-1",
			requests_rest: 2,
			requests_mcp: 0,
			last_feed_request_at: 1_700_006_400_100,
			minimum_poll_interval_ms: 100,
			maximum_poll_interval_ms: 100,
		},
	],
	latency_total_samples: 2,
	latency_samples: [
		{ observed_at: 1_700_006_400_050, duration_ms: 10 },
		{ observed_at: 1_700_006_400_100, duration_ms: 20 },
	],
});

describe("measurement application rules", () => {
	it("uses nearest-rank p95 and retains known zero separately from unknown", () => {
		const response = measurementResponse(
			aggregate,
			{
				database_bytes: { status: "observed", value: 0 },
				referenced_blob_bytes: { status: "observed", value: 0 },
			},
			1_700_006_400_200,
		);

		expect(response.feed_latency.p95).toBe(20);
		expect(response.requests.count).toBe(2);
		expect(response.storage.database_bytes).toEqual({
			status: "observed",
			value: 0,
		});
	});

	it("marks request data stale when feed samples continue after request writes stop", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const requestAt = 1_700_000_000_000;
		const sampleAt = requestAt + 700_000;
		const gateway = createMeasurementGateway(store, () => sampleAt + 100);
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: requestAt,
		});
		gateway.recordFeedPreparation({
			client_id: "device-1",
			observed_at: sampleAt,
			duration_ms: 10,
		});

		const result = gateway.read({
			database_bytes: { status: "observed", value: 0 },
			referenced_blob_bytes: { status: "observed", value: 0 },
		});
		expect(result.requests.count).toBe(1);
		expect(result.requests.observed_from).toBe(requestAt);
		expect(result.requests.observed_through).toBe(requestAt);
		expect(result.requests.stale).toBe(true);
		expect(result.feed_latency.stale).toBe(false);
	});

	it("keeps request counts when a same-day request arrives after its feed sample", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const requestAt = 1_700_000_000_100;
		const sampleAt = requestAt + 20;
		const gateway = createMeasurementGateway(store, () => sampleAt + 1);
		gateway.recordFeedPreparation({
			client_id: "device-1",
			observed_at: sampleAt,
			duration_ms: 10,
		});
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: requestAt,
		});
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: requestAt - 10,
		});

		expect(state.value?.requests_rest).toBe(2);
		expect(state.value?.observed_through).toBe(sampleAt);
		expect(state.value?.observed_from).toBe(requestAt - 10);
		expect(state.value?.request_observed_from).toBe(requestAt - 10);
		expect(state.value?.request_observed_through).toBe(requestAt);
		expect(state.value?.clients[0]?.last_feed_request_at).toBe(requestAt);
		expect(state.value?.clients[0]?.minimum_poll_interval_ms).toBeNull();
	});

	it("keeps the latest latency samples by observation time after reordered arrivals", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const sampleAt = 1_700_000_001_000;
		const gateway = createMeasurementGateway(store, () => sampleAt + 3_000);
		for (let index = 0; index < MEASUREMENT_LIMITS.latencySamples; index += 1) {
			gateway.recordFeedPreparation({
				client_id: "device-1",
				observed_at: sampleAt + index,
				duration_ms: index,
			});
		}
		gateway.recordFeedPreparation({
			client_id: "device-1",
			observed_at: sampleAt + 500,
			duration_ms: 5_000,
		});

		expect(state.value?.latency_total_samples).toBe(2_049);
		expect(state.value?.latency_samples).toHaveLength(2_048);
		expect(state.value?.latency_samples[0]?.observed_at).toBe(sampleAt + 1);
		expect(state.value?.latency_samples.at(-1)?.observed_at).toBe(
			sampleAt + 2_047,
		);
	});

	it("returns unknown request data when no request observation succeeded", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const sampleAt = 1_700_000_000_000;
		const gateway = createMeasurementGateway(store, () => sampleAt + 100);
		gateway.recordFeedPreparation({
			client_id: "device-1",
			observed_at: sampleAt,
			duration_ms: 5,
		});

		const result = gateway.read({
			database_bytes: { status: "observed", value: 0 },
			referenced_blob_bytes: { status: "observed", value: 0 },
		});
		expect(result.requests.status).toBe("unknown");
		expect(result.requests.count).toBeNull();
		expect(result.requests.observed_from).toBeNull();
		expect(result.requests.observed_through).toBeNull();
		expect(result.requests.stale).toBe(true);
	});

	it("returns explicit unknown values on clock rollback without losing the window", () => {
		const response = measurementResponse(
			aggregate,
			{
				database_bytes: { status: "observed", value: 0 },
				referenced_blob_bytes: { status: "observed", value: 0 },
			},
			aggregate.observed_from - 1,
		);

		expect(response.status).toBe("unknown");
		expect(response.requests.count).toBeNull();
		expect(response.day_start).toBe(aggregate.day_start);
		expect(response.storage.database_bytes).toEqual({
			status: "observed",
			value: 0,
		});
	});

	it("preserves stale values and marks their original observation window", () => {
		const response = measurementResponse(
			aggregate,
			{
				database_bytes: { status: "unknown", reason: "storage_error" },
				referenced_blob_bytes: { status: "unknown", reason: "storage_error" },
			},
			1_700_007_001_000,
		);

		expect(response.requests.status).toBe("observed");
		expect(response.requests.stale).toBe(true);
		expect(response.day_start).toBe(aggregate.day_start);
		expect(response.storage.database_bytes.status).toBe("unknown");
	});

	it("reports feed cadence only after observed feed requests", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const gateway = createMeasurementGateway(store);
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: false,
			observed_at: 1_700_000_000_000,
		});
		expect(state.value?.clients[0]?.last_feed_request_at).toBeNull();
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: 1_700_000_000_100,
		});
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: 1_700_000_000_600,
		});
		expect(state.value?.clients[0]).toMatchObject({
			minimum_poll_interval_ms: 500,
			maximum_poll_interval_ms: 500,
		});
	});

	it("evicts only old latency samples and keeps total count plus retained bounds", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const gateway = createMeasurementGateway(store, () => 1_700_000_003_100);
		for (let index = 0; index < 2_049; index += 1) {
			gateway.recordFeedPreparation({
				client_id: "device-1",
				observed_at: 1_700_000_001_000 + index,
				duration_ms: index,
			});
		}
		const result = gateway.read({
			database_bytes: { status: "observed", value: 0 },
			referenced_blob_bytes: { status: "observed", value: 0 },
		});
		expect(result.feed_latency.sample_count).toBe(2_048);
		expect(result.feed_latency.total_sample_count).toBe(2_049);
		expect(result.feed_latency.first_sample_at).toBe(1_700_000_001_001);
		expect(result.feed_latency.last_sample_at).toBe(1_700_000_003_048);
	});

	it("retains known clients at the cap and marks omitted clients unknown", () => {
		let value: MeasurementAggregate | null = null;
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(value);
				if (next) value = next;
			},
			read: () => value,
		};
		const gateway = createMeasurementGateway(store, () => 1_700_000_000_200);
		for (let index = 0; index < MEASUREMENT_LIMITS.clients + 1; index += 1) {
			gateway.recordRequest({
				client_id: `device-${index}`,
				protocol: "rest",
				feed_request: false,
				observed_at: 1_700_000_000_000 + index,
			});
		}
		const result = gateway.read({
			database_bytes: { status: "observed", value: 0 },
			referenced_blob_bytes: { status: "observed", value: 0 },
		});
		expect(result.requests.clients).toHaveLength(MEASUREMENT_LIMITS.clients);
		expect(result.coverage).toBe("unknown");
		expect(result.requests.count).toBe(MEASUREMENT_LIMITS.clients + 1);
	});

	it("rotates at a new UTC day and accepts same-day reordered requests", () => {
		const state: { value: MeasurementAggregate | null } = { value: null };
		const store: MeasurementStore = {
			/** Keep the in-memory test state unchanged when an observation is rejected. */
			update(change) {
				const next = change(state.value);
				if (next) state.value = next;
			},
			read: () => state.value,
		};
		const gateway = createMeasurementGateway(store, () => 1_700_086_400_010);
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: 1_700_000_000_000,
		});
		const priorDay = state.value;
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: 1_700_086_400_000,
		});
		expect(state.value?.day_start).toBe(1_700_006_400_000);
		expect(state.value?.requests_rest).toBe(1);
		gateway.recordRequest({
			client_id: "device-1",
			protocol: "rest",
			feed_request: true,
			observed_at: 1_700_086_399_999,
		});
		expect(state.value).not.toBe(priorDay);
		expect(state.value?.requests_rest).toBe(2);
		expect(state.value?.observed_through).toBe(1_700_086_400_000);
		expect(
			measurementResponse(
				state.value,
				{
					database_bytes: { status: "observed", value: 0 },
					referenced_blob_bytes: { status: "observed", value: 0 },
				},
				1_700_086_399_999,
			).requests.status,
		).toBe("unknown");
	});
});
