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

/** Exposes response settlement without payload data. */
function completion() {
	/** Mark response production complete. */
	let resolve = () => {};
	/** Reject response production to test immediate observation. */
	let reject: (reason: Error) => void = () => {};
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("response production budget", () => {
	it("holds_completed_operations_until_each_response_settles", async () => {
		const responses = Array.from({ length: 4 }, completion);
		const slots = responses.map(({ promise }) => tryAcquireBodySlot(promise));
		let next: (() => void) | undefined;
		try {
			for (const release of slots) {
				release?.();
				release?.();
			}
			const unexpected = tryAcquireBodySlot();
			unexpected?.();
			expect(unexpected).toBeUndefined();
			responses[0]?.resolve();
			await Promise.resolve();
			next = tryAcquireBodySlot();
			expect(next).toBeTypeOf("function");
			expect(tryAcquireBodySlot()).toBeUndefined();
		} finally {
			next?.();
			for (const response of responses) response.resolve();
			for (const release of slots) release?.();
			await Promise.resolve();
		}
	});

	it.each([false, true])(
		"waits_for_operation_cleanup_after_response_settlement_%s",
		async (reject) => {
			const response = completion();
			const slots = [
				tryAcquireBodySlot(response.promise),
				...Array.from({ length: 3 }, () => tryAcquireBodySlot()),
			];
			try {
				if (reject) response.reject(new Error("production failed"));
				else response.resolve();
				await Promise.resolve();
				expect(tryAcquireBodySlot()).toBeUndefined();
			} finally {
				for (const release of slots) release?.();
			}
		},
	);
});
