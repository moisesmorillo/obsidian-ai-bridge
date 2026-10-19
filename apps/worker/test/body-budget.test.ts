import { describe, expect, it } from "vitest";
import { tryAcquireBodySlot } from "../src/application/body-budget";

describe("shared body budget", () => {
	it("shares_four_slots_across_distinct_callers", () => {
		const slots = Array.from({ length: 4 }, () => tryAcquireBodySlot());
		expect(slots.every((slot) => slot !== undefined)).toBe(true);
		expect(tryAcquireBodySlot()).toBeUndefined();
		for (const release of slots) release?.();
	});

	it("does_not_release_a_slot_twice", () => {
		const held = Array.from({ length: 3 }, () => tryAcquireBodySlot());
		const fourth = tryAcquireBodySlot();
		const acquiredAfterRelease: Array<(() => void) | undefined> = [];
		try {
			expect(held.every(Boolean)).toBe(true);
			expect(fourth).toBeTypeOf("function");
			fourth?.();
			fourth?.();
			acquiredAfterRelease.push(tryAcquireBodySlot());
			acquiredAfterRelease.push(tryAcquireBodySlot());
			expect(acquiredAfterRelease[0]).toBeTypeOf("function");
			expect(acquiredAfterRelease[1]).toBeUndefined();
		} finally {
			for (const release of acquiredAfterRelease) release?.();
			fourth?.();
			for (const release of held) release?.();
		}
	});
});
