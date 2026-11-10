import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { pathKey } from "@vaultwire/protocol";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import type { BlobContentStore } from "@worker/application/blobs";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Release one source or cleanup boundary without elapsed-time ordering. */
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Select real blob metadata while recording when response ownership reaches durable settlement. */
async function fixture(store: BlobContentStore, completions: unknown[]) {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("mcp-blob-cancel.invalid"));
	await runInDurableObject(stub, (_instance, state) => {
		clearTestVault(state.storage);
		initializeVaultStorage(
			state.storage,
			() => TEXT_FIXTURE_EPOCH,
			() => Date.now(),
		);
		state.storage.sql.exec(
			"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, 1000001, 'blob', NULL, 0, 1, 'device')",
			"Agents/large.md",
			pathKey("Agents/large.md"),
			"a".repeat(64),
		);
	});
	const gateway = new Proxy(stub, {
		/** Keep native RPC behavior and expose the response owner's settlement boundary. */
		get(target, property) {
			const method = Reflect.get(target, property, target);
			if (typeof method !== "function") return method;
			return async (...args: unknown[]) => {
				if (property === "finishAdmission") completions.push(args[2]);
				return Reflect.apply(method, target, args);
			};
		},
	});
	const worker = createWorker(
		async () => ({
			client_id: "blob-agent",
			grant_id: "blob-grant",
			scopes: ["vault:read"],
		}),
		() => gateway,
		() => store,
	);
	return { worker, stub };
}

afterEach(() => vi.useRealTimers());

describe("MCP blob cancellation ownership", () => {
	it.each(["resolve", "reject"] as const)(
		"retains bytes through the first blob cancellation until cleanup %s",
		async (cleanupResult) => {
			const started = gate();
			const work = gate();
			const workSettled = gate();
			const cancelStarted = gate();
			const cleanup = gate();
			const replacementStarted = gate();
			const replacementBody = gate();
			const abort = new AbortController();
			const completions: unknown[] = [];
			let cancellationSettled = false;
			let cancelCalls = 0;
			let replacementReads = 0;
			const source = new ReadableStream<Uint8Array>(
				{
					type: "bytes",
					/** Hold started blob work independently of the cancellation cleanup. */
					async pull() {
						started.resolve();
						await work.promise;
						workSettled.resolve();
					},
					/** Keep the first native cancellation pending after the source read ends. */
					async cancel(reason) {
						cancelCalls++;
						expect(reason).toBe(abort.signal.reason);
						cancelStarted.resolve();
						await work.promise;
						await cleanup.promise;
						cancellationSettled = true;
						if (cleanupResult === "reject")
							throw new Error("Blob cancellation failed");
					},
				},
				{ highWaterMark: 0 },
			);
			const { worker, stub } = await fixture(
				{
					read: async (hash, size) => {
						expect(hash).toBe("a".repeat(64));
						expect(size).toBe(1_000_001);
						return source;
					},
					head: async () => {
						throw new Error("Unexpected blob head");
					},
					putVerified: async () => {
						throw new Error("Unexpected blob write");
					},
				},
				completions,
			);
			vi.useFakeTimers();
			let responded = false;
			const pending = Promise.resolve(
				worker.fetch(
					new Request("https://mcp-blob-cancel.invalid/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name: "read_note",
								arguments: { path: "Agents/large.md", length: 1 },
							},
						}),
						signal: abort.signal,
					}),
					env,
				),
			).then((response) => {
				responded = true;
				return response;
			});
			const reading = pending
				.then((response) => response.text())
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			const bytes = new TextEncoder().encode(
				'{"jsonrpc":"2.0","id":2,"method":"ping"}'.padEnd(1_000, " "),
			);
			const replacement = Promise.resolve(
				worker.fetch(
					new Request("https://mcp-blob-cancel.invalid/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"content-length": "1000",
						},
						body: new ReadableStream<Uint8Array>(
							{
								type: "bytes",
								/** Demand replacement bytes only after the old blob releases its reservation. */
								async pull(controller) {
									replacementReads++;
									replacementStarted.resolve();
									await replacementBody.promise;
									controller.enqueue(bytes);
									controller.close();
								},
							},
							{ highWaterMark: 0 },
						),
					}),
					env,
				),
			);
			try {
				await started.promise;
				await vi.advanceTimersByTimeAsync(0);
				expect(admissionByteSnapshot().shared_bytes).toBe(64_000_000);
				expect(admissionByteSnapshot().queued_mcp_requests).toBe(1);
				abort.abort(new Error("Blob request aborted"));
				await cancelStarted.promise;
				work.resolve();
				await workSettled.promise;
				await vi.advanceTimersByTimeAsync(0);
				let retainedAdmissions: unknown[] = [];
				// Let native RPC continuations finish while the first blob cancellation stays pending.
				for (let turn = 0; turn < 3; turn++) {
					retainedAdmissions = await runInDurableObject(
						stub,
						(_instance, state) =>
							state.storage.sql
								.exec("SELECT id FROM operation_admissions")
								.toArray(),
					);
					await vi.advanceTimersByTimeAsync(0);
				}
				expect(cancellationSettled).toBe(false);
				expect(admissionByteSnapshot()).toMatchObject({
					shared_bytes: 64_000_000,
					active_reservations: 1,
					queued_mcp_requests: 1,
				});
				expect(source.locked).toBe(true);
				expect(responded).toBe(false);
				expect(completions).toEqual([]);
				expect(retainedAdmissions).toHaveLength(1);
				expect(replacementReads).toBe(0);
				cleanup.resolve();
				await replacementStarted.promise;
				expect((await pending).status).toBe(200);
				expect(await reading).toBeInstanceOf(Error);
				await vi.advanceTimersByTimeAsync(0);
				expect(cancellationSettled).toBe(true);
				expect(source.locked).toBe(false);
				expect(cancelCalls).toBe(1);
				expect(completions).toEqual(["settled"]);
				expect(admissionByteSnapshot()).toMatchObject({
					shared_bytes: 4_136_000,
					active_reservations: 1,
					queued_mcp_requests: 0,
				});
				expect(readSlotCapacitySnapshot().active_slots).toBe(0);
				replacementBody.resolve();
				const response = await replacement;
				expect(response.status).toBe(200);
				await response.json();
				expect(admissionByteSnapshot()).toEqual({
					shared_bytes: 0,
					rest_read_bytes: 0,
					active_reservations: 0,
					queued_mcp_requests: 0,
				});
				expect(
					await runInDurableObject(stub, (_instance, state) =>
						state.storage.sql
							.exec("SELECT id FROM operation_admissions")
							.toArray(),
					),
				).toEqual([]);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				abort.abort(new Error("Blob fixture cleanup"));
				work.resolve();
				cleanup.resolve();
				replacementBody.resolve();
				await reading;
				await (await replacement).text().catch(() => undefined);
			}
		},
	);
});
