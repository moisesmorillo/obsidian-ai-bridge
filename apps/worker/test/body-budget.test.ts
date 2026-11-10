import { describe, expect, it } from "vitest";
import {
	ADMISSION_SHARED_BYTE_LIMIT,
	acquireMcpAdmission,
	admissionByteSnapshot,
	REST_BODY_BYTE_ALLOWANCE,
	REST_HEADING_APPEND_BYTE_ALLOWANCE,
} from "../src/application/admission-budget";
import { tryAcquireBodySlot } from "../src/application/body-budget";

describe("shared body budget", () => {
	it("shares_eight_slots_across_distinct_callers", () => {
		const slots = Array.from({ length: 8 }, () => tryAcquireBodySlot());
		expect(slots.every((slot) => slot !== undefined)).toBe(true);
		expect(tryAcquireBodySlot()).toBeUndefined();
		for (const release of slots) release?.();
	});

	it("does_not_release_a_slot_twice", () => {
		const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
		const eighth = tryAcquireBodySlot();
		const acquiredAfterRelease: Array<(() => void) | undefined> = [];
		try {
			expect(held.every(Boolean)).toBe(true);
			expect(eighth).toBeTypeOf("function");
			eighth?.();
			eighth?.();
			acquiredAfterRelease.push(tryAcquireBodySlot());
			acquiredAfterRelease.push(tryAcquireBodySlot());
			expect(acquiredAfterRelease[0]).toBeTypeOf("function");
			expect(acquiredAfterRelease[1]).toBeUndefined();
		} finally {
			for (const release of acquiredAfterRelease) release?.();
			eighth?.();
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

describe("weighted body reservations", () => {
	it("charges ordinary bodies by their approved byte weight", () => {
		const ordinary = Array.from({ length: 8 }, () =>
			tryAcquireBodySlot(undefined, REST_BODY_BYTE_ALLOWANCE),
		);
		try {
			expect(ordinary.every(Boolean)).toBe(true);
			expect(admissionByteSnapshot().shared_bytes).toBe(
				ADMISSION_SHARED_BYTE_LIMIT,
			);
			expect(
				tryAcquireBodySlot(undefined, REST_BODY_BYTE_ALLOWANCE),
			).toBeUndefined();
		} finally {
			for (const release of ordinary) release?.();
		}
	});

	it("does not charge MCP nested body work a second time", async () => {
		const admission = await acquireMcpAdmission(
			4_136_000,
			new AbortController().signal,
		);
		if (admission.kind !== "admitted")
			throw new Error("Expected MCP admission");
		const before = admissionByteSnapshot().shared_bytes;
		const release = tryAcquireBodySlot(
			undefined,
			REST_BODY_BYTE_ALLOWANCE,
			admission.reservation,
		);
		try {
			expect(release).toBeTypeOf("function");
			expect(admissionByteSnapshot().shared_bytes).toBe(before);
		} finally {
			release?.();
			admission.reservation.release();
		}
	});

	it("holds heading append bytes until response production settles", async () => {
		const response = completion();
		const release = tryAcquireBodySlot(
			response.promise,
			REST_HEADING_APPEND_BYTE_ALLOWANCE,
		);
		if (!release) throw new Error("Expected heading append byte reservation");
		release();
		expect(admissionByteSnapshot().shared_bytes).toBe(
			REST_HEADING_APPEND_BYTE_ALLOWANCE,
		);
		response.resolve();
		await Promise.resolve();
		expect(admissionByteSnapshot().shared_bytes).toBe(0);
	});
});

describe("response production budget", () => {
	it("holds_completed_operations_until_each_response_settles", async () => {
		const responses = Array.from({ length: 8 }, completion);
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
				...Array.from({ length: 7 }, () => tryAcquireBodySlot()),
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
