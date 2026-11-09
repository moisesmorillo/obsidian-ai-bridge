import { admissionByteSnapshot } from "@worker/application/admission-budget";
import {
	type ReadSlotLease,
	readSlotCapacitySnapshot,
	tryAcquireReadSlot,
} from "@worker/application/read-budget";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Retain fixture leases only until each case ends. */
const leases: ReadSlotLease[] = [];

/** Reserve a real REST lease and keep complete physical cleanup under fixture ownership. */
function acquire() {
	const lease = tryAcquireReadSlot();
	if (!lease) throw new Error("Expected a REST lease");
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
	it("recovers measurement capacity at exactly 60000 ms without timer delivery", () => {
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().expired_count;
		Array.from({ length: 4 }, acquire);
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
		Array.from({ length: 4 }, acquire);
		obsolete();
		obsolete.complete();
		expect(readSlotCapacitySnapshot().active_slots).toBe(4);
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		expect(tryAcquireReadSlot()).toBeUndefined();
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
