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
