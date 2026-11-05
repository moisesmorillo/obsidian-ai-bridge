import { collectF4Measurements, formatF4Summary } from "@tooling/f4-collection";
import { describe, expect, it } from "vitest";

const snapshot = {
	requests: {
		status: "observed" as const,
		rest: 12,
		mcp: 3,
		unit: "requests" as const,
		window: { start: "2026-11-05T00:00:00Z", end: "2026-11-06T00:00:00Z" },
		observation: { start: "2026-11-05T01:00:00Z", end: "2026-11-05T03:00:00Z" },
		partialDay: true,
		clientCoverage: "incomplete" as const,
		clients: [
			{
				id: "client_42",
				lastFeedRequestAt: "2026-11-05T03:00:00Z",
				minPollIntervalSeconds: 15,
				maxPollIntervalSeconds: 60,
			},
		],
	},
	feedLatency: {
		status: "observed" as const,
		p95: 125,
		unit: "ms" as const,
		window: { start: "2026-11-05T00:00:00Z", end: "2026-11-06T00:00:00Z" },
		observation: { start: "2026-11-05T01:00:00Z", end: "2026-11-05T03:00:00Z" },
		partialDay: true,
		retainedSamples: 10,
		totalSamples: 10,
		retainedSampleTimes: ["2026-11-05T02:00:00Z", "2026-11-05T03:00:00Z"],
		capExcluded: false,
		method: "nearest-rank",
		boundary: "service-side response preparation",
	},
	storage: {
		status: "observed" as const,
		window: { start: "2026-11-05T03:00:00Z", end: "2026-11-05T03:00:00Z" },
		sqliteAllocatedBytes: 2048,
		referencedR2Bytes: 4096,
		referencedR2Meaning:
			"deduplicated references, not bucket allocation or integrity",
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
		expect(formatF4Summary(result)).toBe(
			[
				"Requests (requests, observed): REST 12, MCP 3.",
				"Window: 2026-11-05T00:00:00Z to 2026-11-06T00:00:00Z. Observed 2026-11-05T01:00:00Z to 2026-11-05T03:00:00Z. Partial day. Client coverage incomplete.",
				"Client client_42: last feed 2026-11-05T03:00:00Z, poll interval 15-60 seconds.",
				"Feed response preparation p95: 125 ms (nearest-rank, 10/10 samples). Retained sample times 2026-11-05T02:00:00Z to 2026-11-05T03:00:00Z.",
				"Storage window: 2026-11-05T03:00:00Z to 2026-11-05T03:00:00Z. SQLite allocation: 2048 bytes. Deduplicated referenced R2: 4096 bytes, not bucket allocation or integrity.",
			].join("\n"),
		);
	});

	it("rejects invalid values without printing raw data", async () => {
		await expect(
			collectF4Measurements(async () => ({
				...snapshot,
				requests: { ...snapshot.requests, rest: -1 },
				secret: "NEVER SHOW",
			})),
		).rejects.toThrow("Invalid measurement data");
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
		try {
			await collectF4Measurements(async () => {
				throw new Error("cookie=SECRET");
			});
		} catch (error) {
			expect(error).toMatchObject({ message: "Measurement read failed" });
			expect(String(error)).not.toContain("SECRET");
		}
	});

	it("keeps explicit unknown latency and stale state instead of converting them to zero", async () => {
		const unknown = {
			...snapshot,
			feedLatency: {
				status: "unknown" as const,
				reason: "no_samples" as const,
				window: snapshot.feedLatency.window,
				p95: null,
				unit: "ms" as const,
				observation: null,
				partialDay: null,
				retainedSamples: 0,
				totalSamples: 0,
				retainedSampleTimes: [],
				capExcluded: false,
				method: "nearest-rank" as const,
				boundary: "service-side response preparation" as const,
			},
			requests: { ...snapshot.requests, status: "stale" as const },
		};
		const result = await collectF4Measurements(async () => unknown);
		expect(result.feedLatency.p95).toBeNull();
		expect(result.feedLatency.status).toBe("unknown");
		expect(result.requests.status).toBe("stale");
		expect(formatF4Summary(result)).toContain(
			"Feed response preparation p95: unknown (no samples).",
		);
	});
});
