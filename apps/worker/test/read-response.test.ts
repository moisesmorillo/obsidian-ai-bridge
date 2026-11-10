import type { AdmissionCompletion } from "@vaultwire/protocol";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import type { ReadSlotLease } from "@worker/application/read-budget";
import {
	tryAcquireReadSlot as acquireReadSlot,
	readSlotCapacitySnapshot,
	waitForReadSlotWork,
} from "@worker/application/read-budget";
import { ReadBatchFailure } from "@worker/application/reads";
import {
	encodeJsonChunks,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Track test-owned leases so each case releases lease ownership during fixture cleanup. */
const testReadLeases = new Set<ReadSlotLease>();

/** Acquire a real lease and retain it for test teardown. */
function tryAcquireReadSlot(
	leaseClass?: "rest" | "mcp",
): ReadSlotLease | undefined {
	const lease = acquireReadSlot(leaseClass);
	if (lease) testReadLeases.add(lease);
	return lease;
}

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
		for (const lease of testReadLeases) {
			lease();
			lease.complete();
		}
		testReadLeases.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(["generic", "fixed-length", "zero-byte"] as const)(
		"expires a %s response but retains bytes until source cleanup",
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
			const expiredAfterSweep = readSlotCapacitySnapshot().expired_count;
			expect(expiredAfterSweep).toBeGreaterThanOrEqual(expiredBefore + 4);
			const available = tryAcquireReadSlot();
			expect(available).toBeUndefined();
			expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			expect(readSlotCapacitySnapshot().expired_count).toBe(expiredAfterSweep);
			available?.();
			for (const release of releases) release.complete();
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
		expect(readSlotCapacitySnapshot().expired_count).toBeGreaterThan(
			expiredBefore,
		);
		const expiredAtDeadline = readSlotCapacitySnapshot().expired_count;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readSlotCapacitySnapshot().expired_count).toBeGreaterThanOrEqual(
			expiredAtDeadline,
		);
		lease.complete();
	});

	it("errors, never closes, a body whose lease expires after its first chunk", async () => {
		vi.useFakeTimers();
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		let pulls = 0;
		const response = ownedReadResponse(
			{
				next: () => {
					pulls += 1;
					return pulls === 1
						? Promise.resolve({
								done: false,
								value: new TextEncoder().encode('{"entries":['),
							})
						: new Promise<IteratorResult<Uint8Array>>(() => {});
				},
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const closed = reader.closed.then(
			() => "closed",
			() => "errored",
		);
		const first = await reader.read();
		expect(first.done).toBe(false);
		const second = reader.read();
		void second.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(second).rejects.toThrow("Read slot hold deadline exceeded");
		expect(await closed).toBe("errored");
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

	it("retains expired fixed-response bytes until writer abort settles", async () => {
		vi.useFakeTimers();
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		const sourceStarted = barrier<void>();
		const work = barrier<IteratorResult<Uint8Array>>();
		const sourceCancelled = barrier<void>();
		const durableFinished = barrier<void>();
		const shutdownStarted = barrier<void>();
		const shutdown = barrier<void>();
		const completed = barrier<void>();
		const complete = lease.complete;
		const completeSpy = vi.spyOn(lease, "complete").mockImplementation(() => {
			complete();
			completed.resolve();
		});
		const getWriter = WritableStream.prototype.getWriter;
		vi.spyOn(WritableStream.prototype, "getWriter").mockImplementation(
			function (this: WritableStream) {
				const writer = getWriter.call(this);
				const abort = writer.abort.bind(writer);
				vi.spyOn(writer, "abort").mockImplementation(async (reason) => {
					shutdownStarted.resolve();
					await shutdown.promise;
					await abort(reason);
				});
				return writer;
			},
		);
		const finished: AdmissionCompletion[] = [];
		let demands = 0;
		const response = ownedReadResponse(
			{
				next: () => {
					if (demands++ === 0)
						return Promise.resolve({
							done: false,
							value: new Uint8Array(65_536),
						});
					sourceStarted.resolve();
					return work.promise;
				},
				cancel: async () => {
					sourceCancelled.resolve();
				},
			},
			{
				finish: async (completion) => {
					finished.push(completion);
					durableFinished.resolve();
					return { ok: true };
				},
			},
			lease,
			undefined,
			undefined,
			65_536,
		);
		const reading = response.arrayBuffer().catch((error: unknown) => error);
		try {
			await sourceStarted.promise;
			await vi.advanceTimersByTimeAsync(60_000);
			await Promise.all([shutdownStarted.promise, sourceCancelled.promise]);
			work.resolve({ done: true, value: undefined });
			await durableFinished.promise;
			await vi.advanceTimersByTimeAsync(0);
			expect(finished).toEqual(["uncertain"]);
			expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			expect(admissionByteSnapshot().rest_read_bytes).toBe(4_500_000);
			expect(completeSpy).not.toHaveBeenCalled();
			shutdown.resolve();
			await completed.promise;
			expect(await reading).toBeInstanceOf(Error);
			expect(admissionByteSnapshot().rest_read_bytes).toBe(0);
			expect(completeSpy).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			work.resolve({ done: true, value: undefined });
			shutdown.resolve();
			await reading;
		}
	});

	it("expires a fixed-length write stalled by an undrained consumer", async () => {
		vi.useFakeTimers();
		const expiredBefore = readSlotCapacitySnapshot().expired_count;
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
		const chunk = new Uint8Array(65_536);
		const chunkCount = 128;
		let sourceCalls = 0;
		const response = ownedReadResponse(
			{
				next: async () => {
					const index = sourceCalls++;
					return index < chunkCount
						? { done: false, value: chunk }
						: { done: true, value: undefined };
				},
				cancel: async () => {},
			},
			{ finish: async () => ({ ok: true }) },
			lease,
			{ headers: { "Content-Length": String(chunk.byteLength * chunkCount) } },
			undefined,
			chunk.byteLength * chunkCount,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		void reader.closed.catch(() => undefined);
		let stableTurns = 0;
		let previousCalls = -1;
		for (let turn = 0; turn < 20 && stableTurns < 3; turn++) {
			await vi.advanceTimersByTimeAsync(1);
			stableTurns = sourceCalls === previousCalls ? stableTurns + 1 : 0;
			previousCalls = sourceCalls;
		}
		expect(stableTurns).toBeGreaterThanOrEqual(3);
		expect(sourceCalls).toBeGreaterThan(1);
		expect(sourceCalls).toBeLessThan(chunkCount + 1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readSlotCapacitySnapshot().expired_count).toBe(expiredBefore + 1);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		const available = tryAcquireReadSlot();
		try {
			expect(available).toBeDefined();
			await expect(reader.read()).rejects.toThrow();
			expect(readSlotCapacitySnapshot().expired_count).toBe(expiredBefore + 1);
		} finally {
			available?.();
			lease.complete();
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
	it("consumer cancellation does not abort the request signal during a pending fixed read", async () => {
		const requestController = new AbortController();
		const request = new Request("https://read.invalid", {
			signal: requestController.signal,
		});
		const nextChunk = barrier<IteratorResult<Uint8Array>>();
		const nextStarted = barrier<void>();
		const finished: AdmissionCompletion[] = [];
		let calls = 0;
		let released = false;
		const response = ownedReadResponse(
			{
				next: () => {
					calls++;
					if (calls === 1)
						return Promise.resolve({
							done: false,
							value: new Uint8Array([1]),
						});
					nextStarted.resolve();
					return nextChunk.promise;
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
			{ headers: { "Content-Length": "1" } },
			request.signal,
			1,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const reading = reader.read().catch(() => undefined);
		await nextStarted.promise;
		const cancellation = reader.cancel();
		await Promise.resolve();
		const signalAbortedAfterConsumerCancellation = request.signal.aborted;
		expect(finished).toEqual([]);
		expect(released).toBe(false);
		nextChunk.resolve({ done: true, value: undefined });
		await Promise.all([reading, cancellation]);
		expect(signalAbortedAfterConsumerCancellation).toBe(false);
		expect(request.signal.aborted).toBe(false);
		expect(calls).toBe(2);
		expect(finished).toEqual(["settled"]);
		expect(released).toBe(true);
	});

	it("does not settle FixedLengthStream writer.closed while the source read waits", async () => {
		const fixed = new FixedLengthStream(3);
		const writer = fixed.writable.getWriter();
		const reader = fixed.readable.getReader();
		const sourceRead = barrier<IteratorResult<Uint8Array>>();
		let sourceReadSettled = false;
		let writerClosedSettled = false;
		const next = sourceRead.promise.then((item) => {
			sourceReadSettled = true;
			return item;
		});
		const producing = next
			.then(async (item) => {
				if (!item.done) await writer.write(item.value);
			})
			.catch(() => {});
		void writer.closed.then(
			() => {
				writerClosedSettled = true;
			},
			() => {
				writerClosedSettled = true;
			},
		);
		const pendingRead = reader.read();
		const consumerCancellation = reader.cancel();
		await Promise.resolve();
		await Promise.resolve();
		const closedBeforeSourceSettled = writerClosedSettled;
		const sourceSettledBeforeCancellation = sourceReadSettled;
		sourceRead.resolve({ done: false, value: new Uint8Array([1, 2, 3]) });
		await Promise.allSettled([
			pendingRead,
			consumerCancellation,
			next,
			producing,
		]);
		expect(closedBeforeSourceSettled).toBe(false);
		expect(sourceSettledBeforeCancellation).toBe(false);
		expect(writerClosedSettled).toBe(true);
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
			for (const release of releases) release.complete();
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
				expect(available).toBeUndefined();
				expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			} finally {
				for (const release of releases) {
					release();
					release.complete();
				}
			}
			lateSettlement.reject(new Error("late private settlement detail"));
		},
		10_000,
	);
	it("retains fixed-response bytes through a pending writer shutdown", async () => {
		const initialBytes = admissionByteSnapshot().rest_read_bytes;
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected an available read slot");
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
				lease();
			},
			{ headers: { "Content-Length": "131072" } },
			signal.signal,
			131072,
			lease,
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
		const bytesBeforeConsumerShutdown = admissionByteSnapshot().rest_read_bytes;
		const completionBeforeConsumerShutdown = [...finished];
		await reader.cancel().catch(() => undefined);
		for (let turn = 0; turn < 30; turn++) await Promise.resolve();
		try {
			expect(retainedWhileWriterShutdownPending).toBe(false);
			expect(bytesBeforeConsumerShutdown).toBe(initialBytes + 4_500_000);
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

	it("recovers admission capacity when timers do not run after the hold deadline", () => {
		vi.useFakeTimers();
		const expiredBefore = readSlotCapacitySnapshot().expired_count;
		const leases = Array.from({ length: 4 }, () => {
			const lease = tryAcquireReadSlot();
			if (!lease) throw new Error("Expected an available read slot");
			return lease;
		});
		vi.spyOn(globalThis, "setTimeout").mockImplementation(
			(() => 0) as unknown as typeof setTimeout,
		);
		vi.setSystemTime(Date.now() + 60_000);
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		for (const lease of leases) lease.complete();
		const recovered = tryAcquireReadSlot();
		try {
			expect(recovered).toBeDefined();
			expect(readSlotCapacitySnapshot().active_slots).toBe(1);
			expect(readSlotCapacitySnapshot().expired_count).toBeGreaterThanOrEqual(
				expiredBefore + 4,
			);
		} finally {
			recovered?.();
			for (const lease of leases) lease();
		}
	});

	it("rejects a late result when completion observes a deadline without timers", async () => {
		vi.useFakeTimers();
		const lease = tryAcquireReadSlot();
		if (!lease) throw new Error("Expected a read lease");
		const work = barrier<string>();
		const waiting = waitForReadSlotWork(lease, work.promise);
		vi.setSystemTime(Date.now() + 60_000);
		work.resolve("late result");
		expect(await waiting).toEqual({ kind: "expired" });
	});

	it.each([undefined, 0, 1])(
		"rejects late EOF with suppressed timers and length %s",
		async (length) => {
			vi.useFakeTimers();
			const lease = tryAcquireReadSlot();
			if (!lease) throw new Error("Expected a read lease");
			const started = barrier<void>();
			const eof = barrier<IteratorResult<Uint8Array>>();
			let first = true;
			const response = ownedReadResponse(
				{
					next: async () => {
						if (length === 1 && first) {
							first = false;
							return { done: false, value: new Uint8Array([1]) };
						}
						started.resolve();
						return eof.promise;
					},
					cancel: async () => {},
				},
				{ finish: async () => ({ ok: true }) },
				lease,
				undefined,
				undefined,
				length,
			);
			const reading = response.arrayBuffer().then(
				() => "successful EOF",
				() => "expired",
			);
			await started.promise;
			vi.setSystemTime(Date.now() + 60_000);
			eof.resolve({ done: true, value: undefined });
			expect(await reading).toBe("expired");
		},
	);

	it.each([false, true])(
		"joins unread response cancellation after expiry, failure %s",
		async (failed) => {
			vi.useFakeTimers();
			const cleanup = barrier<void>();
			const lease = tryAcquireReadSlot();
			if (!lease) throw new Error("Expected a read lease");
			const finished: AdmissionCompletion[] = [];
			const response = ownedReadResponse(
				{
					next: async () => ({ done: true, value: undefined }),
					cancel: () => cleanup.promise,
				},
				{
					finish: async (completion) => {
						finished.push(completion);
						return { ok: true };
					},
				},
				lease,
			);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
			expect(held.every(Boolean)).toBe(true);
			expect(tryAcquireReadSlot()).toBeUndefined();
			if (failed) cleanup.reject(new Error("Source cleanup failed"));
			else cleanup.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(finished).toEqual(["uncertain"]);
			const recovered = tryAcquireReadSlot();
			expect(recovered).toBeDefined();
			expect(vi.getTimerCount()).toBe(4);
			await expect(response.text()).rejects.toThrow("deadline");
		},
	);

	it("keeps REST capacity separate from MCP read leases", () => {
		const mcpLeases = Array.from({ length: 8 }, () => {
			const lease = tryAcquireReadSlot("mcp");
			if (!lease) throw new Error("Expected an available MCP read slot");
			return lease;
		});
		const restLease = tryAcquireReadSlot();
		try {
			expect(restLease).toBeDefined();
			expect(tryAcquireReadSlot("mcp")).toBeUndefined();
			expect(readSlotCapacitySnapshot().active_slots).toBe(9);
		} finally {
			restLease?.();
			for (const lease of mcpLeases) lease();
		}
	});
});
