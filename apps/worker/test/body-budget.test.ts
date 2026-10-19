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
		const release = tryAcquireBodySlot();
		expect(release).toBeTypeOf("function");
		release?.();
		release?.();
		const slots = Array.from({ length: 4 }, () => tryAcquireBodySlot());
		expect(slots.filter(Boolean)).toHaveLength(4);
		for (const slot of slots) slot?.();
	});
});
