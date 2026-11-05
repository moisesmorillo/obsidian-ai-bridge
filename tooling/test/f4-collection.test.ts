import { collectF4Measurements, formatF4Summary } from "@tooling/f4-collection";
import { describe, expect, it } from "vitest";

const snapshot = {
	serviceStatus: "observed" as const,
	coverage: "unknown" as const,
	window: {
		start: "2026-11-05T00:00:00.000Z",
		end: "2026-11-06T00:00:00.000Z",
	},
	observation: {
		start: "2026-11-05T01:00:00.000Z",
		end: "2026-11-05T03:00:00.000Z",
	},
	requests: {
		status: "observed" as const,
		sourceStatus: "observed" as const,
		stale: false,
		count: 15,
		rest: 12,
		mcp: 3,
		unit: "requests" as const,
		window: {
			start: "2026-11-05T00:00:00.000Z",
			end: "2026-11-06T00:00:00.000Z",
		},
		observation: {
			start: "2026-11-05T01:00:00.000Z",
			end: "2026-11-05T03:00:00.000Z",
		},
		partialDay: true,
		clientCoverage: "incomplete" as const,
		clients: [
			{
				id: "client_42",
				rest: 12,
				mcp: 3,
				lastFeedRequestAt: "2026-11-05T03:00:00.000Z",
				minPollIntervalMs: 15_000,
				maxPollIntervalMs: 60_000,
				pollCadenceIncomplete: false,
			},
		],
	},
	feedLatency: {
		status: "observed" as const,
		sourceStatus: "observed" as const,
		stale: false,
		p95: 125,
		unit: "ms" as const,
		window: {
			start: "2026-11-05T00:00:00.000Z",
			end: "2026-11-06T00:00:00.000Z",
		},
		observation: {
			start: "2026-11-05T02:00:00.000Z",
			end: "2026-11-05T03:00:00.000Z",
		},
		partialDay: true,
		retainedSamples: 10,
		totalSamples: 10,
		retainedSampleTimes: [
			"2026-11-05T02:00:00.000Z",
			"2026-11-05T03:00:00.000Z",
		],
		capExcluded: false,
		method: "nearest-rank" as const,
		boundary: "service-side response preparation" as const,
	},
	storage: {
		databaseBytes: { status: "observed" as const, value: 2048 },
		referencedBlobBytes: { status: "observed" as const, value: 4096 },
		meaning:
			"SQLite allocation and deduplicated referenced R2 bytes; not bucket allocation or integrity" as const,
	},
};

describe("F4 service-only collection", () => {
	it("returns an allowlisted projection and deterministic safe text", async () => {
		const result = await collectF4Measurements(async () => ({
			...snapshot,
			ownerSubject: "PRIVATE",
			raw: "cookie=SECRET",
		}));
		expect(result).not.toHaveProperty("ownerSubject");
		expect(result).not.toHaveProperty("raw");
		expect(formatF4Summary(result)).toContain(
			"Requests (observed lower bounds): REST 12, MCP 3 (15 total).",
		);
		expect(formatF4Summary(result)).toContain(
			"Client client_42: REST 12, MCP 3.",
		);
		expect(formatF4Summary(result)).toContain(
			"125 ms (nearest-rank, 10/10 retained/total samples",
		);
	});

	it("keeps explicit unknown and stale states, windows, and reasons", async () => {
		const unknown = {
			...snapshot,
			serviceStatus: "unknown" as const,
			window: null,
			observation: null,
			requests: {
				...snapshot.requests,
				status: "stale" as const,
				sourceStatus: "unknown" as const,
				stale: true,
				count: null,
				rest: null,
				mcp: null,
				window: null,
				observation: null,
				partialDay: null,
				clients: [],
			},
			feedLatency: {
				...snapshot.feedLatency,
				status: "stale" as const,
				sourceStatus: "unknown" as const,
				stale: true,
				p95: null,
				window: null,
				observation: null,
				partialDay: null,
				retainedSamples: 0,
				totalSamples: 0,
				retainedSampleTimes: [],
				reason: "no_samples" as const,
			},
			storage: {
				...snapshot.storage,
				databaseBytes: {
					status: "unknown" as const,
					reason: "storage_error" as const,
					value: undefined,
				},
				referencedBlobBytes: {
					status: "unknown" as const,
					reason: "not_observed" as const,
					value: undefined,
				},
			},
		};
		const result = await collectF4Measurements(async () => unknown);
		expect(result.requests.status).toBe("stale");
		expect(result.requests.sourceStatus).toBe("unknown");
		expect(result.requests.window).toBeNull();
		expect(result.feedLatency.p95).toBeNull();
		expect(result.storage.databaseBytes).toEqual({
			status: "unknown",
			reason: "storage_error",
		});
		expect(formatF4Summary(result)).toContain(
			"Feed response preparation p95: stale (no samples).",
		);
		expect(formatF4Summary(result)).not.toContain("REST 0");
	});

	it("rejects unsafe client identifiers and hides adapter errors", async () => {
		await expect(
			collectF4Measurements(async () => ({
				...snapshot,
				requests: {
					...snapshot.requests,
					clients: [
						{ ...snapshot.requests.clients[0], id: "owner@example.com" },
					],
				},
			})),
		).rejects.toThrow("Invalid measurement data");
		await expect(
			collectF4Measurements(async () => ({
				...snapshot,
				feedLatency: { ...snapshot.feedLatency, window: null },
			})),
		).rejects.toThrow("Invalid measurement data");
		await expect(
			collectF4Measurements(async () => {
				throw new Error("cookie=SECRET");
			}),
		).rejects.toThrow("Measurement read failed");
	});
});
