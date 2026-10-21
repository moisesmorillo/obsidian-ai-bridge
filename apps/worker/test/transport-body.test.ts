import { FileOperationDenied } from "@worker/application/files";
import { readInlineBody } from "@worker/transport/body";
import { describe, expect, it } from "vitest";

/** Accepted inline input never retains borrowed backing storage outside its fixed byte budget. */
describe("readInlineBody", () => {
	it("rejects a tiny view of an oversized borrowed backing buffer", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				/** Offer a small view whose backing allocation cannot enter the retained budget. */
				pull(controller) {
					controller.enqueue(new Uint8Array(2_000_000).subarray(0, 1));
				},
				/** Confirm that rejection stops source demand. */
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		const request = new Request("https://body.invalid", {
			method: "PUT",
			body,
		});
		await expect(readInlineBody(request)).rejects.toMatchObject({
			failure: { kind: "invalid_request" },
		});
		expect(cancelled).toBe(true);
	});
	it("owns one fixed backing allocation instead of a retained source-chunk list", async () => {
		const body = new ReadableStream<Uint8Array>({
			/** Supply distinct borrowed backing buffers that the reader must copy without retaining. */
			start(controller) {
				controller.enqueue(new Uint8Array([0, 255]));
				controller.enqueue(new Uint8Array([128, 1]));
				controller.close();
			},
		});
		const result = await readInlineBody(
			new Request("https://body.invalid", { method: "PUT", body }),
		);
		expect(result).toEqual(new Uint8Array([0, 255, 128, 1]));
		expect(result.buffer.byteLength).toBe(1_000_000);
	});
	it("stops an already cancelled request before source demand", async () => {
		const abort = new AbortController();
		abort.abort();
		let reads = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				/** Record any forbidden demand after caller cancellation. */
				pull() {
					reads++;
				},
			},
			{ highWaterMark: 0 },
		);
		await expect(
			readInlineBody(
				new Request("https://body.invalid", {
					method: "PUT",
					body,
					signal: abort.signal,
				}),
			),
		).rejects.toBeInstanceOf(FileOperationDenied);
		expect(reads).toBe(0);
	});
	it("awaits started source cancellation before its body work settles", async () => {
		/** Retain one controlled source-lifetime resolver, without request data. */
		let enterPull = () => {};
		/** Retain one controlled source-lifetime resolver, without request data. */
		let enterCancel = () => {};
		/** Retain one controlled source-lifetime resolver, without request data. */
		let releasePull = () => {};
		/** Retain one controlled source-lifetime resolver, without request data. */
		let releaseCancel = () => {};
		const pulled = new Promise<void>((resolve) => {
			enterPull = resolve;
		});
		const cancelled = new Promise<void>((resolve) => {
			enterCancel = resolve;
		});
		const pendingPull = new Promise<void>((resolve) => {
			releasePull = resolve;
		});
		const pendingCancel = new Promise<void>((resolve) => {
			releaseCancel = resolve;
		});
		const body = new ReadableStream<Uint8Array>(
			{
				/** Hold body delivery so caller cancellation interrupts an active read. */
				pull() {
					enterPull();
					return pendingPull;
				},
				/** Model a non-cancellable source cleanup operation. */
				cancel() {
					enterCancel();
					return pendingCancel;
				},
			},
			{ highWaterMark: 0 },
		);
		const abort = new AbortController();
		let settled = false;
		const outcome = readInlineBody(
			new Request("https://body.invalid", {
				method: "PUT",
				body,
				signal: abort.signal,
			}),
		).then(
			(value) => {
				settled = true;
				return value;
			},
			(error) => {
				settled = true;
				return error;
			},
		);
		await pulled;
		abort.abort();
		await cancelled;
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(settled).toBe(false);
		} finally {
			releaseCancel();
			releasePull();
		}
		expect(await outcome).toBeInstanceOf(FileOperationDenied);
	});
});
