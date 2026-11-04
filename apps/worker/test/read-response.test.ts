import type { AdmissionCompletion } from "@obsidian-ai-bridge/protocol";
import { ReadBatchFailure } from "@worker/application/reads";
import {
	encodeJsonChunks,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { describe, expect, it } from "vitest";

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
	it("does not demand data or settle at final enqueue before producer EOF", async () => {
		let demands = 0;
		let released = false;
		const finished: AdmissionCompletion[] = [];
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
			() => {
				released = true;
			},
		);
		expect(demands).toBe(0);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		expect((await reader.read()).done).toBe(false);
		expect(demands).toBe(1);
		expect(finished).toEqual([]);
		expect(released).toBe(false);
		expect((await reader.read()).done).toBe(true);
		expect(finished).toEqual(["settled"]);
		expect(released).toBe(true);
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
		expect(released).toBe(false);
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
			expect(released).toBe(false);
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
		expect(released).toBe(false);
		cleanup.resolve();
		await Promise.all([read, cancelled]);
		await Promise.resolve();
		expect(released).toBe(true);
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
		expect(released).toBe(false);
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
