import {
	bodySlotSnapshot,
	tryAcquireBodySlot,
} from "@worker/application/body-budget";
import {
	MUTATION_RESPONSE_SETTLEMENT_GRACE_MS,
	withMutationResponse,
} from "@worker/transport/mutation-response";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Promises the response registered with the platform keep-alive, in registration order. */
const registered: Promise<unknown>[] = [];

vi.mock("cloudflare:workers", async (importOriginal) => ({
	...((await importOriginal()) as object),
	/** Record keep-alive registrations instead of extending the test invocation. */
	waitUntil: (promise: Promise<unknown>) => {
		registered.push(promise);
	},
}));

/** Report whether a promise settled by the time pending microtasks and due fake timers ran. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await vi.advanceTimersByTimeAsync(0);
	return settled;
}

describe("mutation response keep-alive", () => {
	afterEach(() => {
		registered.length = 0;
		vi.useRealTimers();
	});

	it("ends keep-alive within the grace when inner cancellation hangs after a consumer cancel", async () => {
		vi.useFakeTimers();
		let cancelStarted = false;
		const response = await withMutationResponse(async (done) => {
			const release = tryAcquireBodySlot(done);
			release?.();
			return new Response(
				new ReadableStream<Uint8Array>({
					type: "bytes",
					/** Supply one chunk that the consumer never reads. */
					pull(controller) {
						controller.enqueue(new Uint8Array([1]));
					},
					/** Never settle inner cancellation. */
					cancel() {
						cancelStarted = true;
						return new Promise<void>(() => {});
					},
				}),
			);
		});
		expect(registered).toHaveLength(1);
		const keepAlive = registered[0] as Promise<unknown>;
		await response.body?.cancel();
		for (let turn = 0; turn < 20 && !cancelStarted; turn++)
			await vi.advanceTimersByTimeAsync(0);
		expect(cancelStarted).toBe(true);
		await vi.advanceTimersByTimeAsync(
			MUTATION_RESPONSE_SETTLEMENT_GRACE_MS - 1,
		);
		expect(await isSettled(keepAlive)).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await isSettled(keepAlive)).toBe(true);
		// The slot stays held for the body slot reclaim; keep-alive is not capacity release.
		expect(bodySlotSnapshot().responding_slots).toBeGreaterThanOrEqual(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
