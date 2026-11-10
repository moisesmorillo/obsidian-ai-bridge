import {
	ADMISSION_SHARED_BYTE_LIMIT,
	acquireMcpAdmission,
	MCP_ADMISSION_QUEUE_LIMIT,
	mcpAdmissionBytes,
	tryReserveAdmissionBytes,
} from "@worker/application/admission-budget";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

describe("weighted admission budget", () => {
	it("admits exactly the shared byte ceiling and rejects one more byte", () => {
		const ceiling = tryReserveAdmissionBytes(
			"mcp",
			ADMISSION_SHARED_BYTE_LIMIT,
		);
		expect(ceiling).toBeDefined();
		expect(tryReserveAdmissionBytes("rest_body", 1)).toBeUndefined();
		ceiling?.release();
		ceiling?.release();
		const reused = tryReserveAdmissionBytes("rest_body", 1);
		try {
			expect(reused).toBeDefined();
		} finally {
			reused?.release();
		}
	});

	it("uses the checked MCP byte formula and caps the maximum reservation", () => {
		expect(mcpAdmissionBytes(1_000)).toBe(4_136_000);
		expect(mcpAdmissionBytes(6_100_000)).toBe(64_000_000);
		expect(() => mcpAdmissionBytes(6_100_001)).toThrow(RangeError);
	});

	it("wakes a queued MCP request when byte ownership releases", async () => {
		const first = await acquireMcpAdmission(
			ADMISSION_SHARED_BYTE_LIMIT,
			new AbortController().signal,
		);
		expect(first.kind).toBe("admitted");
		if (first.kind !== "admitted") return;
		const controller = new AbortController();
		let settled = false;
		const waiting = acquireMcpAdmission(4_136_000, controller.signal).then(
			(result) => {
				settled = true;
				return result;
			},
		);
		expect(settled).toBe(false);
		first.reservation.release();
		const next = await waiting;
		try {
			expect(next.kind).toBe("admitted");
		} finally {
			if (next.kind === "admitted") next.reservation.release();
		}
	});

	it("times out queued MCP work at the fixed admission deadline", async () => {
		vi.useFakeTimers();
		const first = await acquireMcpAdmission(
			ADMISSION_SHARED_BYTE_LIMIT,
			new AbortController().signal,
		);
		if (first.kind !== "admitted") throw new Error("Expected MCP admission");
		const waiting = acquireMcpAdmission(
			4_136_000,
			new AbortController().signal,
		);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await waiting).toEqual({ kind: "refused", retryAfterSeconds: 2 });
		expect(vi.getTimerCount()).toBe(0);
		first.reservation.release();
	});

	it("admits smaller eligible work without letting a large waiter block it", async () => {
		const fixed = tryReserveAdmissionBytes("rest_body", 58_000_000);
		const slack = tryReserveAdmissionBytes("rest_body", 1_000_000);
		if (!fixed || !slack)
			throw new Error("Expected shared capacity reservations");
		const large = acquireMcpAdmission(8_000_000, new AbortController().signal);
		const small = acquireMcpAdmission(4_136_000, new AbortController().signal);
		slack.release();
		const admitted = await small;
		expect(admitted.kind).toBe("admitted");
		if (admitted.kind !== "admitted") {
			fixed.release();
			return;
		}
		admitted.reservation.release();
		fixed.release();
		const largeResult = await large;
		try {
			expect(largeResult.kind).toBe("admitted");
		} finally {
			if (largeResult.kind === "admitted") largeResult.reservation.release();
		}
	});

	it("bounds the queue at thirty waiters and removes every timeout", async () => {
		vi.useFakeTimers();
		const active = await Promise.all(
			Array.from({ length: 8 }, () =>
				acquireMcpAdmission(4_136_000, new AbortController().signal),
			),
		);
		if (active.some((result) => result.kind !== "admitted"))
			throw new Error("Expected eight active MCP reservations");
		const waiters = Array.from({ length: MCP_ADMISSION_QUEUE_LIMIT }, () =>
			acquireMcpAdmission(4_136_000, new AbortController().signal),
		);
		const overflow = await acquireMcpAdmission(
			4_136_000,
			new AbortController().signal,
		);
		expect(overflow).toEqual({ kind: "refused", retryAfterSeconds: 2 });
		expect(vi.getTimerCount()).toBe(MCP_ADMISSION_QUEUE_LIMIT);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(
			(await Promise.all(waiters)).every((result) => result.kind === "refused"),
		).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		for (const result of active)
			if (result.kind === "admitted") result.reservation.release();
	});

	it("removes an aborted MCP waiter and its timer", async () => {
		vi.useFakeTimers();
		const first = await acquireMcpAdmission(
			ADMISSION_SHARED_BYTE_LIMIT,
			new AbortController().signal,
		);
		if (first.kind !== "admitted") throw new Error("Expected MCP admission");
		const controller = new AbortController();
		const waiting = acquireMcpAdmission(4_136_000, controller.signal);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort();
		expect(await waiting).toEqual({ kind: "refused", retryAfterSeconds: 2 });
		expect(vi.getTimerCount()).toBe(0);
		first.reservation.release();
	});

	it("admits a new small request when an older large waiter cannot fit", async () => {
		vi.useFakeTimers();
		const fixed = tryReserveAdmissionBytes("rest_body", 58_000_000);
		if (!fixed) throw new Error("Expected shared capacity");
		const controller = new AbortController();
		const large = acquireMcpAdmission(8_000_000, controller.signal);
		const small = acquireMcpAdmission(4_136_000, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await small;
		try {
			expect(result.kind).toBe("admitted");
		} finally {
			if (result.kind === "admitted") result.reservation.release();
			controller.abort();
			await large;
			fixed.release();
		}
	});

	it("expires overdue waiters on release when request timers stop", async () => {
		vi.useFakeTimers();
		const fixed = tryReserveAdmissionBytes("rest_body", 64_000_000);
		if (!fixed) throw new Error("Expected shared capacity");
		const waiting = acquireMcpAdmission(
			4_136_000,
			new AbortController().signal,
		);
		vi.setSystemTime(Date.now() + 2_000);
		fixed.release();
		const result = await waiting;
		if (result.kind === "admitted") result.reservation.release();
		expect(result).toEqual({ kind: "refused", retryAfterSeconds: 2 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves FIFO order for eligible waiters and removes idle timers", async () => {
		vi.useFakeTimers();
		const active = await acquireMcpAdmission(
			64_000_000,
			new AbortController().signal,
		);
		if (active.kind !== "admitted") throw new Error("Expected shared capacity");
		const order: number[] = [];
		const waiting = Array.from({ length: 3 }, (_, index) =>
			acquireMcpAdmission(32_000_000, new AbortController().signal).then(
				(result) => {
					order.push(index);
					return result;
				},
			),
		);
		active.reservation.release();
		const first = await waiting[0];
		const second = await waiting[1];
		expect(order).toEqual([0, 1]);
		if (first?.kind === "admitted") first.reservation.release();
		const third = await waiting[2];
		expect(order).toEqual([0, 1, 2]);
		if (second?.kind === "admitted") second.reservation.release();
		if (third?.kind === "admitted") third.reservation.release();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps REST read allowances outside the shared MCP and body budget", () => {
		const shared = tryReserveAdmissionBytes("mcp", ADMISSION_SHARED_BYTE_LIMIT);
		const reads = Array.from({ length: 4 }, () =>
			tryReserveAdmissionBytes("rest_read", 4_500_000),
		);
		try {
			expect(shared).toBeDefined();
			expect(reads.every(Boolean)).toBe(true);
			expect(tryReserveAdmissionBytes("rest_read", 1)).toBeUndefined();
		} finally {
			shared?.release();
			for (const read of reads) read?.release();
		}
	});
});
