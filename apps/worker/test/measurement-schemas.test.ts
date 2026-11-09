import {
	MEASUREMENT_LIMITS,
	MeasurementAggregateSchema,
	MeasurementResponseSchema,
	RequestObservationSchema,
} from "@vaultwire/protocol";
import { describe, expect, it } from "vitest";

describe("measurement schemas", () => {
	it("accepts a known zero count as a partial-day lower bound", () => {
		const parsed = MeasurementResponseSchema.parse({
			status: "observed",
			coverage: "partial",
			day_start: 1_700_000_000_000,
			day_end: 1_700_086_400_000,
			observed_from: 1_700_000_000_000,
			observed_through: 1_700_000_000_000,
			requests: {
				status: "observed",
				count: 0,
				observed_from: 1_700_000_000_000,
				observed_through: 1_700_000_000_000,
				rest_count: 0,
				mcp_count: 0,
				stale: false,
				clients: [],
			},
			feed_latency: {
				status: "unknown",
				unit: "milliseconds",
				sample_count: 0,
				total_sample_count: 0,
				p95: null,
				stale: false,
			},
			storage: {
				database_bytes: { status: "observed", value: 0 },
				referenced_blob_bytes: { status: "observed", value: 0 },
			},
		});

		expect(parsed.requests.count).toBe(0);
		expect(parsed.coverage).toBe("partial");
		expect(parsed.feed_latency.p95).toBeNull();
	});

	it("rejects malformed windows and inconsistent retained sample counts", () => {
		const valid = {
			version: 1,
			day_start: 1_700_006_400_000,
			day_end: 1_700_092_800_000,
			observed_from: 1_700_006_400_001,
			observed_through: 1_700_006_400_002,
			request_observed_from: 1_700_006_400_001,
			request_observed_through: 1_700_006_400_001,
			coverage_incomplete: false,
			requests_rest: 1,
			requests_mcp: 0,
			clients: [
				{
					client_id: "device-1",
					requests_rest: 1,
					requests_mcp: 0,
					last_feed_request_at: null,
					minimum_poll_interval_ms: null,
					maximum_poll_interval_ms: null,
					poll_cadence_incomplete: false,
				},
			],
			latency_total_samples: 0,
			latency_samples: [],
		};
		expect(MeasurementAggregateSchema.safeParse(valid).success).toBe(true);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				day_end: valid.day_end + 1,
			}).success,
		).toBe(false);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				latency_total_samples: 0,
				latency_samples: [{ observed_at: valid.observed_from, duration_ms: 5 }],
			}).success,
		).toBe(false);
	});

	it("rejects samples and requests outside their aggregate observation windows", () => {
		const valid = {
			version: 1,
			day_start: 1_700_006_400_000,
			day_end: 1_700_092_800_000,
			observed_from: 1_700_006_400_001,
			observed_through: 1_700_006_400_002,
			request_observed_from: 1_700_006_400_001,
			request_observed_through: 1_700_006_400_001,
			coverage_incomplete: false,
			requests_rest: 1,
			requests_mcp: 0,
			clients: [
				{
					client_id: "device-1",
					requests_rest: 1,
					requests_mcp: 0,
					last_feed_request_at: null,
					minimum_poll_interval_ms: null,
					maximum_poll_interval_ms: null,
					poll_cadence_incomplete: false,
				},
			],
			latency_total_samples: 0,
			latency_samples: [],
		};
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				request_observed_from: valid.observed_from - 1,
				request_observed_through: valid.observed_from - 1,
			}).success,
		).toBe(false);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				latency_total_samples: 1,
				latency_samples: [
					{ observed_at: valid.observed_from - 1, duration_ms: 5 },
				],
			}).success,
		).toBe(false);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				clients: [
					{
						...valid.clients[0],
						last_feed_request_at: valid.observed_through,
					},
				],
			}).success,
		).toBe(false);
	});

	it("applies the canonical protocol owner retention limits to aggregate rows", () => {
		const limits = MEASUREMENT_LIMITS;
		const valid = {
			version: 1,
			day_start: 1_700_006_400_000,
			day_end: 1_700_092_800_000,
			observed_from: 1_700_006_400_001,
			observed_through: 1_700_006_400_002,
			request_observed_from: 1_700_006_400_001,
			request_observed_through: 1_700_006_400_001,
			coverage_incomplete: true,
			requests_rest: limits.clients + 1,
			requests_mcp: 0,
			clients: Array.from({ length: limits.clients }, (_, index) => ({
				client_id: `device-${index}`,
				requests_rest: 0,
				requests_mcp: 0,
				last_feed_request_at: null,
				minimum_poll_interval_ms: null,
				maximum_poll_interval_ms: null,
				poll_cadence_incomplete: false,
			})),
			latency_total_samples: limits.latencySamples,
			latency_samples: Array.from({ length: limits.latencySamples }, () => ({
				observed_at: 1_700_006_400_001,
				duration_ms: 1,
			})),
		};
		expect(MeasurementAggregateSchema.safeParse(valid).success).toBe(true);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				clients: [
					...valid.clients,
					{
						client_id: "device-over-limit",
						requests_rest: 0,
						requests_mcp: 0,
						last_feed_request_at: null,
						minimum_poll_interval_ms: null,
						maximum_poll_interval_ms: null,
						poll_cadence_incomplete: false,
					},
				],
			}).success,
		).toBe(false);
		expect(
			MeasurementAggregateSchema.safeParse({
				...valid,
				latency_total_samples: limits.latencySamples + 1,
				latency_samples: [
					...valid.latency_samples,
					{ observed_at: 1_700_006_400_001, duration_ms: 1 },
				],
			}).success,
		).toBe(false);
	});

	it("uses the canonical provider client identifier limit", () => {
		expect(
			RequestObservationSchema.safeParse({
				client_id: "x".repeat(2_048),
				protocol: "rest",
				feed_request: false,
				observed_at: 1_700_000_000_000,
			}).success,
		).toBe(true);
		expect(
			RequestObservationSchema.safeParse({
				client_id: "x".repeat(2_049),
				protocol: "rest",
				feed_request: false,
				observed_at: 1_700_000_000_000,
			}).success,
		).toBe(false);
	});

	it("requires verified identity and a request boundary in each observation", () => {
		expect(
			RequestObservationSchema.safeParse({
				client_id: "client-1",
				protocol: "rest",
				feed_request: false,
				observed_at: 1_700_000_000_000,
			}),
		).toMatchObject({ success: true });
		expect(
			RequestObservationSchema.safeParse({
				client_id: "client-1",
				protocol: "rest",
				feed_request: false,
				observed_at: -1,
			}),
		).toMatchObject({ success: false });
	});
});
