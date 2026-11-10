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
