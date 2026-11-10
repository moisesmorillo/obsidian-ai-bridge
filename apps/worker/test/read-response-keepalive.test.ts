import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { READ_SETTLEMENT_DEADLINE_MS } from "@worker/application/reads";
import { ownedReadResponse } from "@worker/transport/read-response";
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

/** Report whether a promise settled by the time pending microtasks and fake timers ran. */
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

describe("owned read response keep-alive", () => {
	afterEach(() => {
		registered.length = 0;
		vi.useRealTimers();
	});

	it("rejects an invalid known length before registering keep-alive work", () => {
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		try {
			expect(() =>
				ownedReadResponse(
					{
						next: async () => ({ done: true, value: undefined }),
						cancel: async () => {},
					},
					{ finish: async () => ({ ok: true }) },
					lease,
					undefined,
					undefined,
					-1,
				),
			).toThrow(RangeError);
			expect(registered).toHaveLength(0);
		} finally {
			lease();
			lease.complete();
		}
	});

	it("ends keep-alive within the settlement grace after a deadline whose cleanup never settles", async () => {
		vi.useFakeTimers();
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		const cancelStarted = Promise.withResolvers<void>();
		const response = ownedReadResponse(
			{
				next: async () => {
					throw new Error("source failed");
				},
				cancel: () => {
					cancelStarted.resolve();
					return new Promise<void>(() => {});
				},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
		);
		expect(registered).toHaveLength(1);
		const keepAlive = registered[0] as Promise<unknown>;
		const reading = response.arrayBuffer().catch((error: unknown) => error);
		await cancelStarted.promise;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await reading).toBeInstanceOf(Error);
		expect(await isSettled(keepAlive)).toBe(false);
		await vi.advanceTimersByTimeAsync(READ_SETTLEMENT_DEADLINE_MS);
		expect(await isSettled(keepAlive)).toBe(true);
		lease();
		lease.complete();
	});

	it("ends keep-alive when a response completes", async () => {
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		const response = ownedReadResponse(
			{
				next: async () => ({ done: true, value: undefined }),
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
		);
		await response.arrayBuffer();
		await expect(registered[0]).resolves.toBeUndefined();
	});
});
