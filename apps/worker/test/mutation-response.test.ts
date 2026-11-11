import {
	admissionByteSnapshot,
	REST_BODY_BYTE_ALLOWANCE,
} from "@worker/application/admission-budget";
import {
	BODY_RESPONSE_DEADLINE_MS,
	BODY_RESPONSE_RECLAIM_GRACE_MS,
	bodySlotSnapshot,
	tryAcquireBodySlot,
} from "@worker/application/body-budget";
import { withMutationResponse } from "@worker/transport/mutation-response";
import { describe, expect, it, vi } from "vitest";

/** Exposes a controlled producer or cleanup completion without a timer. */
function gate() {
	/** Release the controlled producer or cleanup wait. */
	let resolve = () => {};
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Assert capacity without leaking an unexpected slot on failure. */
function expectFull() {
	const unexpected = tryAcquireBodySlot();
	unexpected?.();
	expect(unexpected).toBeUndefined();
}

/** Assert exactly one returned slot, then return all test-owned capacity. */
function expectOneFree() {
	const free = tryAcquireBodySlot();
	try {
		expect(free).toBeTypeOf("function");
		expectFull();
	} finally {
		free?.();
	}
}

describe("mutation response production", () => {
	it("holds_eight_completed_operations_through_final_chunk_until_EOF", async () => {
		const ends = Array.from({ length: 8 }, gate);
		const responses = await Promise.all(
			ends.map((end) =>
				withMutationResponse(async (done) => {
					const release = tryAcquireBodySlot(done);
					expect(release).toBeTypeOf("function");
					release?.();
					let supplied = false;
					return new Response(
						new ReadableStream<Uint8Array>({
							type: "bytes",
							/** Return one bounded chunk, then hold EOF under test control. */
							async pull(controller) {
								if (!supplied) {
									supplied = true;
									controller.enqueue(new Uint8Array([42]));
								} else {
									await end.promise;
									controller.close();
									if ("byobRequest" in controller)
										controller.byobRequest?.respond(0);
								}
							},
						}),
					);
				}),
			),
		);
		try {
			expectFull();
			const reader = responses[0]?.body?.getReader();
			expect((await reader?.read())?.value).toEqual(new Uint8Array([42]));
			expectFull();
			ends[0]?.resolve();
			expect((await reader?.read())?.done).toBe(true);
			expectOneFree();
			reader?.releaseLock();
		} finally {
			for (const end of ends) end.resolve();
			for (const response of responses.slice(1)) await response.body?.cancel();
			// Cancel returns before the pump observes it, so wait for the slots to return.
			await vi.waitFor(() => expect(bodySlotSnapshot().active_slots).toBe(0));
		}
	});

	it.each([false, true])(
		"waits_for_pending_read_and_cancel_cleanup_%s",
		async (failCleanup) => {
			const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
			const entered = gate();
			const finishRead = gate();
			const finishCancel = gate();
			let cancelled = false;
			const response = await withMutationResponse(async (done) => {
				const release = tryAcquireBodySlot(done);
				release?.();
				return new Response(
					new ReadableStream<Uint8Array>({
						type: "bytes",
						/** Hold the pending application read, then supply one byte. */
						async pull(controller) {
							entered.resolve();
							await finishRead.promise;
							controller.enqueue(new Uint8Array([1]));
						},
						/** Keep cleanup pending, with an optional observed failure. */
						async cancel() {
							cancelled = true;
							await finishCancel.promise;
							if (failCleanup) throw new Error("cleanup");
						},
					}),
				);
			});
			const reader = response.body?.getReader();
			// The native body rejects this pending consumer read when the consumer cancels.
			const pending = expect(reader?.read()).rejects.toThrow(
				"Stream was cancelled",
			);
			await entered.promise;
			const cancellation = reader?.cancel();
			try {
				// The pump sees the cancel at its next write, after the pending inner read settles.
				await cancellation;
				expect(cancelled).toBe(false);
				expectFull();
				finishRead.resolve();
				await vi.waitFor(() => expect(cancelled).toBe(true));
				expectFull();
				finishCancel.resolve();
				await pending;
				await vi.waitFor(() =>
					expect(bodySlotSnapshot().responding_slots).toBe(0),
				);
				expectOneFree();
			} finally {
				finishRead.resolve();
				finishCancel.resolve();
				await Promise.allSettled([pending, cancellation]);
				reader?.releaseLock();
				for (const release of held) release?.();
			}
		},
	);

	it("releases_after_response_construction_failure", async () => {
		const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
		try {
			await expect(
				withMutationResponse(async (done) => {
					const release = tryAcquireBodySlot(done);
					try {
						return new Response("invalid", { status: 204 });
					} finally {
						release?.();
					}
				}),
			).rejects.toThrow();
			expectOneFree();
		} finally {
			for (const release of held) release?.();
		}
	});
});

describe("mutation response terminal paths", () => {
	it("releases_after_a_producer_error_and_keeps_the_error_visible", async () => {
		const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
		try {
			const response = await withMutationResponse(async (done) => {
				const release = tryAcquireBodySlot(done);
				release?.();
				return new Response(
					new ReadableStream<Uint8Array>({
						type: "bytes",
						/** Expose a real source failure to the wrapper reader. */
						pull() {
							throw new Error("source failed");
						},
					}),
				);
			});
			await expect(response.text()).rejects.toThrow("source failed");
			expectOneFree();
		} finally {
			for (const release of held) release?.();
		}
	});

	it("completes_a_response_without_a_body", async () => {
		const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
		try {
			const response = await withMutationResponse(async (done) => {
				const release = tryAcquireBodySlot(done);
				release?.();
				return new Response(null, { status: 204 });
			});
			expect(response.status).toBe(204);
			expectOneFree();
		} finally {
			for (const release of held) release?.();
		}
	});
});

describe("mutation response backpressure", () => {
	it("requests_at_most_65536_bytes_only_under_downstream_demand", async () => {
		let reads = 0;
		let supplied = 0;
		const response = await withMutationResponse(async (done) => {
			const release = tryAcquireBodySlot(done);
			release?.();
			return new Response(
				new ReadableStream<Uint8Array>({
					type: "bytes",
					/** Supply only the owned bounded read view, with no queued source chunks. */
					pull(controller) {
						reads++;
						if (!("byobRequest" in controller) || !controller.byobRequest?.view)
							throw new Error("Expected BYOB demand");
						const request = controller.byobRequest;
						const view = request.view;
						if (!view) throw new Error("Expected read buffer");
						expect(view.byteLength).toBeLessThanOrEqual(65_536);
						if (supplied === 131_073) {
							controller.close();
							request.respond(0);
							return;
						}
						const size = Math.min(view.byteLength, 131_073 - supplied);
						new Uint8Array(view.buffer, view.byteOffset, size).fill(42);
						supplied += size;
						request.respond(size);
					},
				}),
			);
		});
		// The pump reads one bounded chunk ahead of the consumer and waits on its unread write.
		await vi.waitFor(() => expect(reads).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reads).toBe(1);
		const reader = response.body?.getReader();
		try {
			const first = await reader?.read();
			expect(first?.value?.byteLength).toBeGreaterThan(0);
			expect(first?.value?.byteLength).toBeLessThanOrEqual(65_536);
			expect(reads).toBeLessThanOrEqual(2);
			let total = first?.value?.byteLength ?? 0;
			for (;;) {
				const item = await reader?.read();
				if (!item || item.done) break;
				expect(item.value.byteLength).toBeLessThanOrEqual(65_536);
				expect(item.value[0]).toBe(42);
				total += item.value.byteLength;
			}
			expect(total).toBe(131_073);
			expect(reads).toBeGreaterThanOrEqual(4);
		} finally {
			await reader?.cancel();
			reader?.releaseLock();
		}
	});
});

describe("mutation response preparation", () => {
	it("holds_capacity_between_operation_return_and_response_creation", async () => {
		const held = Array.from({ length: 7 }, () => tryAcquireBodySlot());
		const operationDone = gate();
		const prepare = gate();
		const response = withMutationResponse(async (done) => {
			const release = tryAcquireBodySlot(done);
			release?.();
			operationDone.resolve();
			await prepare.promise;
			return Response.json({ ok: true });
		});
		try {
			await operationDone.promise;
			expectFull();
			prepare.resolve();
			const prepared = await response;
			expectFull();
			expect(await prepared.json()).toEqual({ ok: true });
			expectOneFree();
		} finally {
			prepare.resolve();
			const prepared = await response;
			if (!prepared.bodyUsed) await prepared.body?.cancel();
			for (const release of held) release?.();
		}
	});
});

describe("mutation response deadline and reclaim", () => {
	it("errors an unread body at its deadline and returns its slot and bytes", async () => {
		vi.useFakeTimers();
		const sharedBefore = admissionByteSnapshot().shared_bytes;
		let cancelled = false;
		try {
			const response = await withMutationResponse(async (done) => {
				const release = tryAcquireBodySlot(done);
				release?.();
				return new Response(
					new ReadableStream<Uint8Array>({
						type: "bytes",
						/** Supply one chunk that the client never reads. */
						pull(controller) {
							controller.enqueue(new Uint8Array([1]));
						},
						/** Record that the deadline canceled the inner body. */
						cancel() {
							cancelled = true;
						},
					}),
				);
			});
			const reader = response.body?.getReader();
			await vi.advanceTimersByTimeAsync(BODY_RESPONSE_DEADLINE_MS - 1);
			expect(bodySlotSnapshot().responding_slots).toBe(1);
			const reclaimedBefore = bodySlotSnapshot().reclaimed_unsettled_count;
			await vi.advanceTimersByTimeAsync(1);
			expect(cancelled).toBe(true);
			await expect(reader?.read()).rejects.toThrow();
			expect(bodySlotSnapshot().responding_slots).toBe(0);
			expect(bodySlotSnapshot().reclaimed_unsettled_count).toBe(
				reclaimedBefore,
			);
			expect(admissionByteSnapshot().shared_bytes).toBe(sharedBefore);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reclaims a slot whose inner cancellation never settles, once and without timers", async () => {
		vi.useFakeTimers();
		const sharedBefore = admissionByteSnapshot().shared_bytes;
		const cleanup = gate();
		try {
			const response = await withMutationResponse(async (done) => {
				const release = tryAcquireBodySlot(done);
				release?.();
				return new Response(
					new ReadableStream<Uint8Array>({
						type: "bytes",
						/** Supply one chunk that the client never reads. */
						pull(controller) {
							controller.enqueue(new Uint8Array([1]));
						},
						/** Keep inner cancellation pending past the reclaim deadline. */
						cancel: () => cleanup.promise,
					}),
				);
			});
			const reader = response.body?.getReader();
			await vi.advanceTimersByTimeAsync(BODY_RESPONSE_DEADLINE_MS);
			await expect(reader?.read()).rejects.toThrow();
			const atDeadline = bodySlotSnapshot();
			expect(atDeadline.responding_slots).toBe(1);
			expect(admissionByteSnapshot().shared_bytes).toBe(
				sharedBefore + REST_BODY_BYTE_ALLOWANCE,
			);
			vi.setSystemTime(Date.now() + BODY_RESPONSE_RECLAIM_GRACE_MS - 1);
			expect(bodySlotSnapshot().responding_slots).toBe(1);
			vi.setSystemTime(Date.now() + 1);
			const reclaimed = bodySlotSnapshot();
			expect(reclaimed.responding_slots).toBe(0);
			expect(reclaimed.active_slots).toBe(atDeadline.active_slots - 1);
			expect(reclaimed.reclaimed_unsettled_count).toBe(
				atDeadline.reclaimed_unsettled_count + 1,
			);
			expect(admissionByteSnapshot().shared_bytes).toBe(sharedBefore);
			cleanup.resolve();
			await vi.advanceTimersByTimeAsync(0);
			const late = bodySlotSnapshot();
			expect(late.active_slots).toBe(reclaimed.active_slots);
			expect(late.reclaimed_unsettled_count).toBe(
				reclaimed.reclaimed_unsettled_count,
			);
			expect(admissionByteSnapshot().shared_bytes).toBe(sharedBefore);
		} finally {
			cleanup.resolve();
			vi.useRealTimers();
		}
	});
});
