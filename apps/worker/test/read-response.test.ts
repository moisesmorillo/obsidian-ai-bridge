import type { AdmissionCompletion } from "@obsidian-ai-bridge/protocol";
import {
	readSlotCapacitySnapshot,
	tryAcquireReadSlot,
	waitForReadSlotWork,
} from "@worker/application/read-budget";
import { ReadBatchFailure } from "@worker/application/reads";
import {
	encodeJsonChunks,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Expose explicit work and cleanup barriers without timer ordering. */
function barrier<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("owned read response", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(["generic", "fixed-length", "zero-byte"] as const)(
		"expires a %s response with an unresolved source and releases a fifth slot",
		async (framing) => {
			vi.useFakeTimers();
			const expiredBefore = readSlotCapacitySnapshot().expired_count;
			const releases = Array.from({ length: 4 }, () => {
				const release = tryAcquireReadSlot();
				if (!release) throw new Error("Expected an available read slot");
				return release;
			});
			const sourceStarted = barrier<void>();
			const never = new Promise<IteratorResult<Uint8Array>>(() => {});
			const response = ownedReadResponse(
				{
					next: () => {
						sourceStarted.resolve();
						return never;
					},
					cancel: async () => {},
				},
				{ finish: async () => ({ ok: true }) },
				releases[0],
				undefined,
				undefined,
				framing === "fixed-length"
					? 1
					: framing === "zero-byte"
						? 0
						: undefined,
			);
			const reading = response.arrayBuffer().then(
				() => undefined,
				(error: unknown) => error,
			);
			await sourceStarted.promise;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await reading).toBeInstanceOf(Error);
			expect(readSlotCapacitySnapshot().expired_count).toBe(expiredBefore + 4);
			const fifth = tryAcquireReadSlot();
			try {
				expect(fifth).toBeDefined();
			} finally {
				fifth?.();
				for (const release of releases) release();
			}
		},
	);

	it("counts expiry after capacity release and fails the unfinished response once", async () => {
		vi.useFakeTimers();
		const expiredBefore = readSlotCapacitySnapshot().expired_count;
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		lease();
		lease();
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		const response = ownedReadResponse(
			{
				next: async () => ({ done: true, value: undefined }),
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		void reader.closed.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(reader.read()).rejects.toThrow();
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		expect(readSlotCapacitySnapshot().expired_count).toBe(expiredBefore + 1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readSlotCapacitySnapshot().expired_count).toBe(expiredBefore + 1);
		lease.complete();
	});

	it("returns an expiry result when response preparation misses its lease", async () => {
		vi.useFakeTimers();
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		const result = waitForReadSlotWork(lease, new Promise<string>(() => {}));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await result).toEqual({ kind: "expired" });
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		const response = ownedReadResponse(
			{
				next: async () => ({ done: true, value: undefined }),
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
		);
		const failed = response.arrayBuffer().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(await failed).toBeInstanceOf(Error);
		lease.complete();
	});

	it("releases a slot at the deadline when source cancellation never settles", async () => {
		vi.useFakeTimers();
		const release = tryAcquireReadSlot();
		if (!release) throw new Error("Expected an available read slot");
		const cancelStarted = barrier<void>();
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
			release,
		);
		const reading = response.arrayBuffer().then(
			() => undefined,
			(error: unknown) => error,
		);
		await cancelStarted.promise;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await reading).toBeInstanceOf(Error);
		const available = tryAcquireReadSlot();
		try {
			expect(available).toBeDefined();
		} finally {
			available?.();
			release();
		}
	});

	it("fails an undrained response at the deadline and rejects late source completion", async () => {
		vi.useFakeTimers();
		const release = tryAcquireReadSlot();
		if (!release) throw new Error("Expected an available read slot");
		let demands = 0;
		const response = ownedReadResponse(
			{
				next: async () => {
					demands++;
					return { done: true, value: undefined };
				},
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			release,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		void reader.closed.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(reader.read()).rejects.toThrow();
		expect(demands).toBe(0);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		release.complete();
	});
	it.each([
		["generic", undefined],
		["fixed-length", 1],
		["zero-byte fixed-length", 0],
	] as const)(
		"fails %s response when durable settlement resolves with failure",
		async (_framing, length) => {
			let emitted = false;
			const init =
				length === undefined
					? undefined
					: {
							status: 206,
							headers: { "Content-Length": String(length) },
						};
			const response = ownedReadResponse(
				{
					next: async () => {
						if (length === 1 && !emitted) {
							emitted = true;
							return { done: false, value: new Uint8Array([1]) };
						}
						return { done: true, value: undefined };
					},
					cancel: async () => {},
				},
				{
					finish: async () => ({
						ok: false,
						failure: { kind: "revoked" },
					}),
				},
				() => {},
				init,
				undefined,
				length,
			);
			if (length !== undefined) {
				expect(response.status).toBe(206);
				expect(response.headers.get("Content-Length")).toBe(String(length));
			}
			await expect(response.arrayBuffer()).rejects.toThrow();
		},
	);
	it("waits for successful settlement before completing a zero-byte fixed response", async () => {
		const finishing = barrier<void>();
		const settlement = barrier<void>();
		const response = ownedReadResponse(
			{
				next: async () => ({ done: true, value: undefined }),
				cancel: async () => {},
			},
			{
				finish: async () => {
					finishing.resolve();
					await settlement.promise;
					return { ok: true };
				},
			},
			() => {},
			{ status: 206, headers: { "Content-Length": "0" } },
			undefined,
			0,
		);
		const reading = response.arrayBuffer();
		await finishing.promise;
		let completed = false;
		void reading.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		settlement.resolve();
		expect((await reading).byteLength).toBe(0);
		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Length")).toBe("0");
	});
	it("does not demand data or settle at final enqueue before producer EOF", async () => {
		let demands = 0;
		const finished: AdmissionCompletion[] = [];
		vi.useFakeTimers();
		const release = tryAcquireReadSlot();
		if (!release) throw new Error("Expected an available read slot");
		const response = ownedReadResponse(
			{
				next: async () => {
					demands++;
					return demands === 1
						? { done: false, value: new Uint8Array([1]) }
						: { done: true, value: undefined };
				},
				cancel: async () => {},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					return { ok: true };
				},
			},
			release,
		);
		expect(demands).toBe(0);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		expect((await reader.read()).done).toBe(false);
		expect(demands).toBe(1);
		expect(finished).toEqual([]);
		expect(readSlotCapacitySnapshot().active_slots).toBe(1);
		expect((await reader.read()).done).toBe(true);
		expect(finished).toEqual(["settled"]);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects source completion that arrives after the deadline", async () => {
		vi.useFakeTimers();
		const work = barrier<IteratorResult<Uint8Array>>();
		const started = barrier<void>();
		const release = tryAcquireReadSlot();
		if (!release) throw new Error("Expected an available read slot");
		const finished: AdmissionCompletion[] = [];
		const response = ownedReadResponse(
			{
				next: () => {
					started.resolve();
					return work.promise;
				},
				cancel: async () => {},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					return { ok: true };
				},
			},
			release,
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Read response has no body");
		const read = reader.read().then(
			() => undefined,
			(error: unknown) => error,
		);
		await started.promise;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await read).toBeInstanceOf(Error);
		work.resolve({ done: true, value: undefined });
		await Promise.resolve();
		expect(finished).not.toContain("settled");
		release.complete();
	});
	it("joins pending producer work and cancellation before durable cleanup and slot reuse", async () => {
		const work = barrier<IteratorResult<Uint8Array>>();
		const started = barrier<void>();
		const cancellation = barrier<void>();
		const cancelling = barrier<void>();
		const cleanup = barrier<void>();
		const finishing = barrier<void>();
		let released = false;
		const response = ownedReadResponse(
			{
				next: () => {
					started.resolve();
					return work.promise;
				},
				cancel: () => {
					cancelling.resolve();
					return cancellation.promise;
				},
			},
			{
				finish: async () => {
					finishing.resolve();
					await cleanup.promise;
					return { ok: true };
				},
			},
			() => {
				released = true;
			},
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const read = reader.read();
		await started.promise;
		const cancelled = reader.cancel();
		await cancelling.promise;
		expect(released).toBe(false);
		cancellation.resolve();
		expect(released).toBe(false);
		work.resolve({ done: true, value: undefined });
		await finishing.promise;
		expect(released).toBe(true);
		cleanup.resolve();
		await Promise.all([read, cancelled]);
		expect(released).toBe(true);
	});
	it.each([
		"known producer",
		"unknown producer",
		"unknown cancellation",
	] as const)(
		"preserves joined outcome certainty for %s without early slot release",
		async (fault) => {
			const work = barrier<IteratorResult<Uint8Array>>();
			const started = barrier<void>();
			const cancellation = barrier<void>();
			const cancelling = barrier<void>();
			const cleanup = barrier<void>();
			const finishing = barrier<void>();
			const finished: AdmissionCompletion[] = [];
			let released = false;
			const response = ownedReadResponse(
				{
					next: () => {
						started.resolve();
						return work.promise;
					},
					cancel: () => {
						cancelling.resolve();
						return cancellation.promise;
					},
				},
				{
					finish: async (completion) => {
						finished.push(completion);
						finishing.resolve();
						await cleanup.promise;
						return { ok: true };
					},
				},
				() => {
					released = true;
				},
			);
			if (!response.body) throw new Error("Read response has no body");
			const reader = response.body.getReader();
			const read = reader.read();
			await started.promise;
			const cancelled = reader.cancel();
			await cancelling.promise;
			work.reject(
				fault === "unknown producer"
					? new Error("Lost pending RPC")
					: new ReadBatchFailure({ kind: "cursor_expired" }),
			);
			expect(released).toBe(false);
			expect(finished).toEqual([]);
			if (fault === "unknown cancellation")
				cancellation.reject(new Error("Cancellation failed"));
			else cancellation.resolve();
			await finishing.promise;
			expect(released).toBe(true);
			cleanup.resolve();
			await Promise.all([read, cancelled]);
			expect(finished).toEqual([
				fault === "known producer" ? "settled" : "uncertain",
			]);
			expect(released).toBe(true);
		},
	);

	it("joins a pending read before fixed-body cancellation cleanup", async () => {
		const work = barrier<IteratorResult<Uint8Array>>();
		const started = barrier<void>();
		const cancellationStarted = barrier<void>();
		const cancellation = barrier<void>();
		const cleanupStarted = barrier<void>();
		const cleanup = barrier<void>();
		const finished: AdmissionCompletion[] = [];
		let released = false;
		let cancellationDemanded = false;
		let calls = 0;
		const response = ownedReadResponse(
			{
				next: () => {
					calls++;
					if (calls === 1)
						return Promise.resolve({
							done: false,
							value: new Uint8Array([1]),
						});
					started.resolve();
					return work.promise;
				},
				cancel: () => {
					cancellationDemanded = true;
					cancellationStarted.resolve();
					return cancellation.promise;
				},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					cleanupStarted.resolve();
					await cleanup.promise;
					return { ok: true };
				},
			},
			() => {
				released = true;
			},
			{ headers: { "Content-Length": "3" } },
			undefined,
			3,
		);
		const body = response.body;
		if (!body) throw new Error("Read response has no body");
		const reader = body.getReader();
		const read = reader.read().catch(() => undefined);
		await started.promise;
		const cancelled = reader.cancel();
		await Promise.resolve();
		const cancellationWasPrompt = cancellationDemanded;
		work.resolve({ done: false, value: new Uint8Array([2, 3]) });
		await cancellationStarted.promise;
		expect(cancellationWasPrompt).toBe(false);
		expect(finished).toEqual([]);
		expect(released).toBe(false);
		cancellation.resolve();
		await cleanupStarted.promise;
		expect(finished).toEqual(["settled"]);
		expect(released).toBe(true);
		cleanup.resolve();
		await Promise.all([read, cancelled]);
		for (let attempt = 0; attempt < 10 && !released; attempt++)
			await Promise.resolve();
		expect(released).toBe(true);
	});
	it.each(["generic", "fixed-length"] as const)(
		"releases local slots after %s source completion when settlement rejects",
		async (framing) => {
			const releases = Array.from({ length: 4 }, () => {
				const release = tryAcquireReadSlot();
				if (!release) throw new Error("Expected an available read slot");
				return release;
			});
			const settlement = barrier<void>();
			let emitted = false;
			const response = ownedReadResponse(
				{
					next: async () => {
						if (framing === "fixed-length" && !emitted) {
							emitted = true;
							return { done: false, value: new Uint8Array([1]) };
						}
						return { done: true, value: undefined };
					},
					cancel: async () => {},
				},
				{
					finish: () => settlement.promise.then(() => ({ ok: true })),
				},
				() => {
					for (const release of releases) release();
				},
				undefined,
				undefined,
				framing === "fixed-length" ? 1 : undefined,
			);
			const fifth = tryAcquireReadSlot();
			expect(fifth).toBeUndefined();
			const reading = response.arrayBuffer();
			settlement.reject(new Error("durable settlement rejected"));
			await expect(reading).rejects.toThrow();
			const reused = tryAcquireReadSlot();
			try {
				expect(reused).toBeDefined();
			} finally {
				reused?.();
				for (const release of releases) release();
			}
		},
	);
	it.each(["generic", "fixed-length"] as const)(
		"fails a %s response and releases local slots when durable settlement exceeds its deadline",
		async (framing) => {
			const releases = Array.from({ length: 4 }, () => {
				const release = tryAcquireReadSlot();
				if (!release) throw new Error("Expected an available read slot");
				return release;
			});
			const lateSettlement = barrier<never>();
			let emitted = false;
			const response = ownedReadResponse(
				{
					next: async () => {
						if (framing === "fixed-length" && !emitted) {
							emitted = true;
							return { done: false, value: new Uint8Array([1]) };
						}
						return { done: true, value: undefined };
					},
					cancel: async () => {},
				},
				{ finish: () => lateSettlement.promise },
				() => {
					for (const release of releases) release();
				},
				undefined,
				undefined,
				framing === "fixed-length" ? 1 : undefined,
			);
			try {
				await expect(response.arrayBuffer()).rejects.toThrow();
				const available = tryAcquireReadSlot();
				expect(available).toBeDefined();
				available?.();
			} finally {
				for (const release of releases) release();
			}
			lateSettlement.reject(new Error("late private settlement detail"));
		},
		10_000,
	);
	it("keeps the slot until an aborted fixed-body write and shutdown settle", async () => {
		const eofReached = barrier<void>();
		const durableSettled = barrier<void>();
		const signal = new AbortController();
		const finished: AdmissionCompletion[] = [];
		let nextChunk = 0;
		let released = false;
		const chunks = [new Uint8Array(65_536), new Uint8Array(65_536)];
		const response = ownedReadResponse(
			{
				next: () => {
					const value = chunks[nextChunk];
					if (value !== undefined) {
						nextChunk++;
						return Promise.resolve({ done: false, value });
					}
					eofReached.resolve();
					return Promise.resolve({ done: true, value: undefined });
				},
				cancel: async () => {},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					durableSettled.resolve();
					return { ok: true };
				},
			},
			() => {
				released = true;
			},
			{ headers: { "Content-Length": "131072" } },
			signal.signal,
			131072,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		void reader.closed.catch(() => undefined);
		let firstWriteBytes = 0;
		while (firstWriteBytes < 65_536) {
			const item = await reader.read();
			firstWriteBytes += item.value?.byteLength ?? 0;
		}
		await Promise.all([eofReached.promise, durableSettled.promise]);
		await Promise.resolve();
		signal.abort(new Error("Request aborted"));
		await Promise.resolve();
		const retainedWhileWriterShutdownPending = !released;
		const completionBeforeConsumerShutdown = [...finished];
		await reader.cancel().catch(() => undefined);
		for (let attempt = 0; attempt < 10 && !released; attempt++)
			await Promise.resolve();
		try {
			expect(retainedWhileWriterShutdownPending).toBe(false);
			expect(completionBeforeConsumerShutdown).toEqual(["settled"]);
			expect(released).toBe(true);
		} finally {
			signal.abort();
			await reader.cancel().catch(() => undefined);
		}
	});
	it("marks a rejected fixed-body cancellation uncertain and keeps the slot through cleanup", async () => {
		const work = barrier<IteratorResult<Uint8Array>>();
		const started = barrier<void>();
		const cancelStarted = barrier<void>();
		const cancelFailure = barrier<void>();
		const cleanupStarted = barrier<void>();
		const cleanup = barrier<void>();
		const finished: AdmissionCompletion[] = [];
		let released = false;
		let cancellationCalled = false;
		let calls = 0;
		const response = ownedReadResponse(
			{
				next: () => {
					calls++;
					if (calls === 1)
						return Promise.resolve({
							done: false,
							value: new Uint8Array([1]),
						});
					started.resolve();
					return work.promise;
				},
				cancel: () => {
					cancellationCalled = true;
					cancelStarted.resolve();
					return cancelFailure.promise.then(() => {
						throw new Error("Source cancel failed");
					});
				},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					cleanupStarted.resolve();
					await cleanup.promise;
					return { ok: true };
				},
			},
			() => {
				released = true;
			},
			{ headers: { "Content-Length": "3" } },
			undefined,
			3,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const read = reader.read().catch(() => undefined);
		await started.promise;
		await reader.cancel();
		expect(cancellationCalled).toBe(false);
		expect(finished).toEqual([]);
		work.resolve({ done: false, value: new Uint8Array([2, 3]) });
		await cancelStarted.promise;
		expect(finished).toEqual([]);
		expect(released).toBe(false);
		cancelFailure.resolve();
		await cleanupStarted.promise;
		expect(finished).toEqual(["uncertain"]);
		expect(released).toBe(true);
		cleanup.resolve();
		await read;
		for (let attempt = 0; attempt < 10 && !released; attempt++)
			await Promise.resolve();
		expect(released).toBe(true);
	});
	it("validates known-length EOF and preserves source fault certainty", async () => {
		for (const [fault, expected] of [
			["eof", "settled"],
			["known", "settled"],
			["unknown", "uncertain"],
		] as const) {
			const finished: AdmissionCompletion[] = [];
			let released = false;
			let calls = 0;
			const response = ownedReadResponse(
				{
					next: async () => {
						calls++;
						if (fault === "eof")
							return calls === 1
								? { done: false, value: new Uint8Array([1, 2, 3]) }
								: { done: true, value: undefined };
						throw fault === "known"
							? new ReadBatchFailure({ kind: "cursor_expired" })
							: new Error("Storage result unknown");
					},
					cancel: async () => {},
				},
				{
					finish: async (completion) => {
						finished.push(completion);
						return { ok: true };
					},
				},
				() => {
					released = true;
				},
				{ headers: { "Content-Length": "3" } },
				undefined,
				3,
			);
			if (fault === "eof") {
				expect(new Uint8Array(await response.arrayBuffer())).toEqual(
					new Uint8Array([1, 2, 3]),
				);
			} else {
				await expect(response.arrayBuffer()).rejects.toThrow();
			}
			expect(finished).toEqual([expected]);
			expect(released).toBe(true);
		}
	});
	it("keeps unknown producer faults uncertain and observes rejected cleanup", async () => {
		let released = false;
		const finished: AdmissionCompletion[] = [];
		const response = ownedReadResponse(
			{
				next: async () => {
					throw new Error("RPC lost");
				},
				cancel: async () => {
					throw new Error("cancel failed");
				},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					throw new Error("cleanup failed");
				},
			},
			() => {
				released = true;
			},
		);
		await expect(response.text()).rejects.toThrow();
		expect(finished).toEqual(["uncertain"]);
		expect(released).toBe(true);
	});
	it("encodes control characters and surrogate boundaries with bounded chunks", () => {
		const content = `${"\u0000".repeat(8191)}😀\ud800${"\u0001".repeat(150_000)}`;
		const chunks = [...encodeJsonChunks({ content })];
		expect(chunks.every((chunk) => chunk.byteLength <= 65_536)).toBe(true);
		const text = chunks
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");
		expect(JSON.parse(text)).toEqual({ content });
	});
});
