import {
	MeasurementAggregateSchema,
	MeasurementResponseSchema,
	RequestObservationSchema,
} from "@obsidian-ai-bridge/protocol";
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
