import { admissionByteSnapshot } from "@worker/application/admission-budget";
import {
	type ReadSlotClass,
	type ReadSlotLease,
	readSlotCapacitySnapshot,
	readSlotRetryAfterSeconds,
	tryAcquireReadSlot,
} from "@worker/application/read-budget";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Retain fixture leases only until each case ends. */
const leases: ReadSlotLease[] = [];

/** Reserve a real lease and keep complete physical cleanup under fixture ownership. */
function acquire(leaseClass: ReadSlotClass = "rest") {
	const lease = tryAcquireReadSlot(leaseClass);
	if (!lease) throw new Error("Expected an available read lease");
	leases.push(lease);
	return lease;
}

afterEach(() => {
	for (const lease of leases) {
		lease();
		lease.complete();
	}
	leases.length = 0;
	vi.useRealTimers();
});

describe("absolute read lease ownership", () => {
	it("uses the local retry fallback when physical completion has no estimate", () => {
		vi.useFakeTimers();
		Array.from({ length: 4 }, () => acquire());
		vi.setSystemTime(Date.now() + 60_000);
		expect(readSlotRetryAfterSeconds("rest")).toBe(2);
		expect(readSlotRetryAfterSeconds("mcp")).toBe(2);
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("excludes released and completed leases from retry estimates", () => {
		vi.useFakeTimers();
		const released = acquire("mcp");
		released();
		vi.setSystemTime(Date.now() + 10_000);
		acquire("mcp").complete();
		vi.setSystemTime(Date.now() + 10_000);
		const current = Array.from({ length: 8 }, () => acquire("mcp"));
		expect(readSlotRetryAfterSeconds("mcp")).toBe(60);
		current[0]?.();
		expect(readSlotRetryAfterSeconds("mcp")).toBe(2);
	});

	it("recovers measurement capacity at exactly 60000 ms without timer delivery", () => {
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().expired_count;
		Array.from({ length: 4 }, () => acquire());
		vi.setSystemTime(Date.now() + 59_999);
		expect(readSlotCapacitySnapshot().active_slots).toBe(4);
		vi.setSystemTime(Date.now() + 1);
		expect(readSlotCapacitySnapshot()).toMatchObject({
			active_slots: 0,
			available_slots: 12,
			expired_count: before + 4,
		});
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a completed lease outside later expiry observations", () => {
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().expired_count;
		const lease = acquire();
		let notified = false;
		lease.onExpire(() => {
			notified = true;
		});
		lease.complete();
		vi.setSystemTime(Date.now() + 60_000);
		expect(lease.expired).toBe(false);
		expect(notified).toBe(false);
		expect(readSlotCapacitySnapshot().expired_count).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps stale release and completion separate from replacement count and bytes", () => {
		vi.useFakeTimers();
		const obsolete = acquire();
		obsolete();
		obsolete.complete();
		Array.from({ length: 4 }, () => acquire());
		obsolete();
		obsolete.complete();
		expect(readSlotCapacitySnapshot().active_slots).toBe(4);
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		expect(tryAcquireReadSlot()).toBeUndefined();
	});

	it("reclaims unsettled bytes once at the deadline plus grace without a timer", () => {
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().reclaimed_unsettled_count ?? 0;
		const stalled = Array.from({ length: 4 }, () => acquire());
		vi.setSystemTime(Date.now() + 60_000);
		expect(tryAcquireReadSlot()).toBeUndefined();
		vi.setSystemTime(Date.now() + 59_999);
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		vi.setSystemTime(Date.now() + 1);
		const admitted = acquire();
		expect(admissionByteSnapshot().rest_read_bytes).toBe(4_500_000);
		expect(readSlotCapacitySnapshot().reclaimed_unsettled_count).toBe(
			before + 4,
		);
		for (const lease of stalled) lease.complete();
		expect(admissionByteSnapshot().rest_read_bytes).toBe(4_500_000);
		admitted.complete();
		expect(admissionByteSnapshot().rest_read_bytes).toBe(0);
		expect(readSlotCapacitySnapshot().reclaimed_unsettled_count).toBe(
			before + 4,
		);
	});

	it("notifies other listeners when one expiry listener throws", () => {
		vi.useFakeTimers();
		const lease = acquire();
		const observed: string[] = [];
		lease.onExpire(() => {
			throw new Error("Fixture listener failed");
		});
		lease.onExpire(() => {
			observed.push("expired");
		});
		vi.setSystemTime(Date.now() + 60_000);
		expect(lease.expired).toBe(true);
		expect(observed).toEqual(["expired"]);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
