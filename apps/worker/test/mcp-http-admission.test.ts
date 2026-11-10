import { env, runInDurableObject } from "cloudflare:test";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Release a controlled native source or cancellation wait. */
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Keep request bytes small with an independently checked 1,000-byte envelope. */
const ping = new TextEncoder().encode(
	'{"jsonrpc":"2.0","id":1,"method":"ping"}'.padEnd(1_000, " "),
);

/** Use the real router and native epoch authority without external authentication work. */
async function fixture() {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("mcp-admission.invalid"));
	await runInDurableObject(stub, (_instance, state) => {
		clearTestVault(state.storage);
		initializeVaultStorage(
			state.storage,
			() => TEXT_FIXTURE_EPOCH,
			() => Date.now(),
		);
	});
	return createWorker(
		async () => ({
			client_id: "admission-agent",
			grant_id: "admission-grant",
			scopes: ["vault:read"],
		}),
		() => stub,
		() => new R2BlobStore(env.R2_BUCKET),
	);
}

/** Create a demand-observed request whose native source stops at an explicit gate. */
function heldRequest(
	length: string | undefined = "1000",
	signal?: AbortSignal,
) {
	const started = gate();
	const resume = gate();
	let reads = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			type: "bytes",
			/** Hold actual body delivery independently of MCP queue ownership. */
			async pull(controller) {
				reads++;
				started.resolve();
				await resume.promise;
				controller.enqueue(ping.slice());
				controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	const headers = new Headers({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	});
	if (length !== undefined) headers.set("content-length", length);
	return {
		request: new Request("https://mcp-admission.invalid/mcp", {
			method: "POST",
			headers,
			body,
			signal,
		}),
		started: started.promise,
		resume: resume.resolve,
		reads: () => reads,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("MCP HTTP admission ownership", () => {
	it.each([
		[-1, 60],
		[0, 60],
		[999, 60],
		[1_000, 59],
		[1_001, 59],
		[30_001, 30],
		[58_001, 2],
		[59_999, 2],
		[60_000, null],
	] as const)(
		"uses absolute MCP read deadlines after %i ms",
		async (elapsed, retry) => {
			const worker = await fixture();
			vi.useFakeTimers();
			const started = Date.now();
			const held = [tryAcquireReadSlot()];
			try {
				vi.setSystemTime(started + 10_000);
				held.push(tryAcquireReadSlot("mcp"));
				vi.setSystemTime(started + 20_000);
				held.push(
					...Array.from({ length: 7 }, () => tryAcquireReadSlot("mcp")),
				);
				expect(held.every((lease) => lease !== undefined)).toBe(true);
				vi.setSystemTime(started + 10_000 + elapsed);
				const body = JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "list_notes", arguments: {} },
				});
				const response = await worker.fetch(
					new Request("https://mcp-admission.invalid/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"content-length": String(body.length),
						},
						body,
					}),
					env,
				);
				expect(response.status).toBe(retry === null ? 200 : 429);
				expect(response.headers.get("retry-after")).toBe(
					retry === null ? null : String(retry),
				);
				await response.text();
				expect(admissionByteSnapshot().shared_bytes).toBe(0);
			} finally {
				for (const lease of held) {
					lease?.();
					lease?.complete();
				}
			}
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("recovers expired MCP response capacity before envelope admission when timers stop", async () => {
		const worker = await fixture();
		const first = await worker.fetch(
			new Request("https://mcp-admission.invalid/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "list_notes", arguments: {} },
				}),
			}),
			env,
		);
		expect(first.status).toBe(200);
		expect(admissionByteSnapshot().shared_bytes).toBe(64_000_000);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		const input = heldRequest();
		input.resume();
		try {
			const next = await worker.fetch(input.request, env);
			expect(next.status).toBe(200);
			await next.json();
			await expect(first.text()).rejects.toThrow("deadline");
			expect(admissionByteSnapshot().active_reservations).toBe(0);
		} finally {
			await first.body?.cancel().catch(() => undefined);
		}
	});
	it("holds eight small envelopes and cancels a ninth queued body without demand", async () => {
		const worker = await fixture();
		vi.useFakeTimers();
		const bodies = Array.from({ length: 8 }, () => heldRequest());
		const calls = bodies.map((input) => worker.fetch(input.request, env));
		await Promise.all(bodies.map((input) => input.started));
		expect(admissionByteSnapshot().shared_bytes).toBe(33_088_000);
		const abort = new AbortController();
		const queued = heldRequest("1000", abort.signal);
		const waiting = worker.fetch(queued.request, env);
		await vi.advanceTimersByTimeAsync(0);
		expect(queued.reads()).toBe(0);
		expect(admissionByteSnapshot().queued_mcp_requests).toBe(1);
		abort.abort();
		const refused = await waiting;
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("2");
		expect(queued.reads()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		for (const input of bodies) input.resume();
		for (const response of await Promise.all(calls)) {
			expect(response.status).toBe(200);
			await response.json();
		}
		expect(admissionByteSnapshot().active_reservations).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reserves the full absent-length bound and times out without body demand", async () => {
		const worker = await fixture();
		vi.useFakeTimers();
		const first = heldRequest();
		const active = worker.fetch(first.request, env);
		await first.started;
		const queued = heldRequest();
		queued.request.headers.delete("content-length");
		const waiting = worker.fetch(queued.request, env);
		await vi.advanceTimersByTimeAsync(0);
		expect(admissionByteSnapshot().queued_mcp_requests).toBe(1);
		expect(queued.reads()).toBe(0);
		await vi.advanceTimersByTimeAsync(2_000);
		const refused = await waiting;
		expect(refused.status).toBe(429);
		expect(queued.reads()).toBe(0);
		first.resume();
		await (await active).json();
		expect(admissionByteSnapshot().active_reservations).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("admits the maximum absent-length envelope through bounded native reads", async () => {
		const worker = await fixture();
		let supplied = 0;
		let maximumView = 0;
		const response = await worker.fetch(
			new Request("https://mcp-admission.invalid/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: new ReadableStream<Uint8Array>(
					{
						type: "bytes",
						/** Fill only the native read view instead of allocating a complete test envelope. */
						pull(controller) {
							if (
								!("byobRequest" in controller) ||
								!controller.byobRequest?.view
							)
								throw new Error("Expected bounded BYOB demand");
							const request = controller.byobRequest;
							const view = request.view;
							if (!view) throw new Error("Expected a read view");
							maximumView = Math.max(maximumView, view.byteLength);
							if (supplied === 6_100_000) {
								controller.close();
								request.respond(0);
								return;
							}
							const size = Math.min(view.byteLength, 6_100_000 - supplied);
							const bytes = new Uint8Array(view.buffer, view.byteOffset, size);
							bytes.fill(32);
							if (supplied === 0) bytes.set(ping);
							supplied += size;
							request.respond(size);
						},
					},
					{ highWaterMark: 0 },
				),
			}),
			env,
		);
		expect(response.status).toBe(200);
		await response.json();
		expect(supplied).toBe(6_100_000);
		expect(maximumView).toBeLessThanOrEqual(65_536);
		expect(admissionByteSnapshot().active_reservations).toBe(0);
	});

	it("enforces a false declared bound before JSON decoding", async () => {
		const worker = await fixture();
		const input = heldRequest("999");
		const pending = worker.fetch(input.request, env);
		input.resume();
		const response = await pending;
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request_too_large" });
		expect(admissionByteSnapshot().active_reservations).toBe(0);
	});

	it("joins the first native body cancellation before it releases physical bytes", async () => {
		const worker = await fixture();
		vi.useFakeTimers();
		const started = gate();
		const cancelStarted = gate();
		const cleanup = gate();
		const abort = new AbortController();
		const input = heldRequest("1000", abort.signal);
		const request = new Request(input.request, {
			body: new ReadableStream<Uint8Array>(
				{
					type: "bytes",
					/** Keep one native read pending until cancellation ends it. */
					pull() {
						started.resolve();
					},
					/** Retain physical source ownership until native cancellation settles. */
					cancel() {
						cancelStarted.resolve();
						return cleanup.promise;
					},
				},
				{ highWaterMark: 0 },
			),
		});
		let responded = false;
		const pending = Promise.resolve(worker.fetch(request, env)).then(
			(response) => {
				responded = true;
				return response;
			},
		);
		await started.promise;
		abort.abort();
		await cancelStarted.promise;
		await vi.advanceTimersByTimeAsync(0);
		expect(responded).toBe(false);
		expect(admissionByteSnapshot().shared_bytes).toBe(4_136_000);
		cleanup.resolve();
		const response = await pending;
		expect(response.status).toBe(500);
		await expect(response.text()).rejects.toThrow();
		expect(admissionByteSnapshot().active_reservations).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
