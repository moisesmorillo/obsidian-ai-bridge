import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@vaultwire/protocol";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import {
	seedLiveTextState,
	TEXT_FIXTURE_EPOCH,
} from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Release one started RPC without a timer or payload reference. */
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Synthetic identity uses only the isolated test authority. */
const identity: AuthorizationContext = {
	client_id: "expiry-client",
	grant_id: "expiry-grant",
	scopes: ["vault:read", "vault:write"],
};

afterEach(() => vi.useRealTimers());

describe("read preparation expiry ownership", () => {
	it.each([
		["/v1/vault", "readVault"],
		["/v1/manifest", "readVault"],
		["/v1/manifest", "readBatch"],
		["/v1/search?q=task", "search"],
		["/v1/files/task.md", "authorize"],
		["/v1/files/task.md", "readText"],
		["/mcp", "readText"],
	] as const)(
		"retains bytes for %s during late %s cleanup",
		async (route, stage) => {
			const host = "expiry.invalid";
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			await runInDurableObject(stub, async (_instance, state) => {
				clearTestVault(state.storage);
				state.storage.sql.exec("PRAGMA foreign_keys = ON");
				initializeVaultStorage(
					state.storage,
					() => TEXT_FIXTURE_EPOCH,
					() => 10_000,
				);
				await seedLiveTextState(state.storage, {
					path: "task.md",
					content: "task",
				});
				state.storage.sql.exec("DELETE FROM operation_admissions");
			});
			const started = gate();
			const resume = gate();
			const finished = gate();
			const completions: unknown[] = [];
			const gateway = new Proxy(stub, {
				/** Delay one native result without changing authority or its original deadline. */
				get(target, property) {
					const method = Reflect.get(target, property, target);
					if (typeof method !== "function") return method;
					return async (...args: unknown[]) => {
						const result = await Reflect.apply(method, target, args);
						if (property === stage) {
							started.resolve();
							await resume.promise;
						}
						if (property === "finishAdmission") {
							completions.push(args[2]);
							finished.resolve();
						}
						return result;
					};
				},
			});
			const worker = createWorker(
				async () => identity,
				() => gateway,
				() => new R2BlobStore(env.R2_BUCKET),
			);
			vi.useFakeTimers();
			const body = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "read_note", arguments: { path: "task.md" } },
			});
			const pending = worker.fetch(
				new Request(
					`https://${host}${route}`,
					route === "/mcp"
						? {
								method: "POST",
								headers: {
									"content-type": "application/json",
									accept: "application/json, text/event-stream",
									"content-length": String(body.length),
								},
								body,
							}
						: undefined,
				),
				env,
			);
			await started.promise;
			vi.setSystemTime(Date.now() + 60_000);
			expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			const response = await pending;
			expect(response.status).toBe(500);
			await response.text();
			const retained = admissionByteSnapshot();
			expect(
				route === "/mcp" ? retained.shared_bytes : retained.rest_read_bytes,
			).toBeGreaterThan(0);
			resume.resolve();
			await finished.promise;
			expect(completions).toEqual(["uncertain"]);
			await vi.advanceTimersByTimeAsync(0);
			expect(admissionByteSnapshot()).toEqual({
				shared_bytes: 0,
				rest_read_bytes: 0,
				active_reservations: 0,
				queued_mcp_requests: 0,
			});
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("unsettled REST read reclaim", () => {
	it("admits a device read after four stalled feed reads pass their grace", async () => {
		const host = "reclaim.invalid";
		const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
			await seedLiveTextState(state.storage, {
				path: "task.md",
				content: "task",
			});
			state.storage.sql.exec("DELETE FROM operation_admissions");
		});
		const stalled = gate();
		let started = 0;
		const allStarted = gate();
		const gateway = new Proxy(stub, {
			/** Stall the first four feed batches after native work, as a never-settling RPC would. */
			get(target, property) {
				const method = Reflect.get(target, property, target);
				if (typeof method !== "function") return method;
				return async (...args: unknown[]) => {
					const result = await Reflect.apply(method, target, args);
					if (property === "readBatch" && started < 4) {
						started += 1;
						if (started === 4) allStarted.resolve();
						await stalled.promise;
					}
					return result;
				};
			},
		});
		const worker = createWorker(
			async () => identity,
			() => gateway,
			() => new R2BlobStore(env.R2_BUCKET),
		);
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().reclaimed_unsettled_count ?? 0;
		const feeds = Array.from({ length: 4 }, () =>
			worker.fetch(
				new Request(
					`https://${host}/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0`,
				),
				env,
			),
		);
		await allStarted.promise;
		vi.setSystemTime(Date.now() + 60_000);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		for (const response of await Promise.all(feeds)) {
			expect(response.status).toBe(500);
			await response.text();
		}
		expect(admissionByteSnapshot().rest_read_bytes).toBe(18_000_000);
		const limited = await worker.fetch(
			new Request(`https://${host}/v1/vault`),
			env,
		);
		expect(limited.status).toBe(429);
		await limited.text();
		vi.setSystemTime(Date.now() + 60_000);
		const admitted = await worker.fetch(
			new Request(`https://${host}/v1/vault`),
			env,
		);
		expect(admitted.status).toBe(200);
		expect(await admitted.json()).toMatchObject({ epoch: TEXT_FIXTURE_EPOCH });
		expect(readSlotCapacitySnapshot().reclaimed_unsettled_count).toBe(
			before + 4,
		);
		stalled.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() =>
			expect(admissionByteSnapshot().rest_read_bytes).toBe(0),
		);
		expect(readSlotCapacitySnapshot().reclaimed_unsettled_count).toBe(
			before + 4,
		);
	});
});

describe("unsettled MCP read reclaim", () => {
	it("releases shared bytes of eight stalled MCP reads after their grace", async () => {
		const host = "mcp-reclaim.invalid";
		const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
			await seedLiveTextState(state.storage, {
				path: "task.md",
				content: "task",
			});
			state.storage.sql.exec("DELETE FROM operation_admissions");
		});
		const stalled = gate();
		const allStarted = gate();
		let started = 0;
		const gateway = new Proxy(stub, {
			/** Stall the first eight note reads after native work, as a never-settling RPC would. */
			get(target, property) {
				const method = Reflect.get(target, property, target);
				if (typeof method !== "function") return method;
				return async (...args: unknown[]) => {
					const result = await Reflect.apply(method, target, args);
					if (property === "readText" && started < 8) {
						started += 1;
						if (started === 8) allStarted.resolve();
						await stalled.promise;
					}
					return result;
				};
			},
		});
		const worker = createWorker(
			async () => identity,
			() => gateway,
			() => new R2BlobStore(env.R2_BUCKET),
		);
		/** Build one MCP read_note request with an exact Content-Length. */
		const readNote = (id: number) => {
			const body = JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name: "read_note", arguments: { path: "task.md" } },
			});
			return worker.fetch(
				new Request(`https://${host}/mcp`, {
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
		};
		vi.useFakeTimers();
		const before = readSlotCapacitySnapshot().reclaimed_unsettled_count ?? 0;
		const reads = Array.from({ length: 8 }, (_, index) => readNote(index + 1));
		await allStarted.promise;
		vi.setSystemTime(Date.now() + 60_000);
		expect(readSlotCapacitySnapshot().active_slots).toBe(0);
		for (const response of await Promise.all(reads)) {
			expect(response.status).toBe(500);
			await response.text();
		}
		expect(admissionByteSnapshot().shared_bytes).toBeGreaterThan(0);
		const refused = readNote(9);
		await vi.advanceTimersByTimeAsync(2_000);
		const limited = await refused;
		expect(limited.status).toBe(429);
		await limited.text();
		vi.setSystemTime(Date.now() + 58_000);
		expect(readSlotCapacitySnapshot()).toMatchObject({
			shared_bytes: 0,
			held_mcp_slots: 0,
			reclaimed_unsettled_count: before + 8,
		});
		const admitted = await readNote(10);
		expect(admitted.status).toBe(200);
		await admitted.text();
		stalled.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() =>
			expect(admissionByteSnapshot()).toMatchObject({
				shared_bytes: 0,
				active_reservations: 0,
			}),
		);
		expect(readSlotCapacitySnapshot().reclaimed_unsettled_count).toBe(
			before + 8,
		);
	});
});
