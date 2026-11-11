import type { AuthorizationContext } from "@vaultwire/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import { listMcpBases } from "@worker/application/mcp-bases";
import { readMcpNote } from "@worker/application/mcp-notes";
import { VaultOverloaded } from "@worker/application/vault-overload";
import { acquireTestReadSlot as tryAcquireReadSlot } from "@worker/test-fixtures/read-slot";
import { describe, expect, it } from "vitest";

/** Hold started storage work until a test releases its completion barrier. */
function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Identity scoped to the read authority used by one application operation. */
const identity: AuthorizationContext = {
	client_id: "mcp-client",
	grant_id: "mcp-grant",
	scopes: ["vault:read"],
};

describe("MCP list preparation cancellation", () => {
	it("settles an authorized Base list when cancellation aborts before summary read", async () => {
		const signal = new AbortController();
		const finished: string[] = [];
		let summaryReads = 0;
		const gateway = {
			authorize: async () => {
				signal.abort();
				return {
					ok: true as const,
					ticket: { id: "mcp-list-ticket", expires_at: 1_000 },
				};
			},
			readVault: async () => {
				summaryReads += 1;
				return { ok: true as const, body: {} };
			},
			finishAdmission: async (
				_identity: unknown,
				_ticket: string,
				result: string,
			) => {
				finished.push(result);
				return { ok: true as const };
			},
		} as unknown as Parameters<typeof listMcpBases>[0];
		const outcome = await listMcpBases(
			gateway,
			identity,
			undefined,
			false,
			signal.signal,
		);
		if (outcome.owner === undefined) throw new Error("Expected response owner");
		await outcome.owner.cancel();
		await outcome.owner.finish("settled");
		await outcome.owner.finish("settled");
		expect(outcome).toMatchObject({
			ok: false,
			failure: { kind: "internal_error" },
			owner: { completion: "settled", sourceComplete: true },
		});
		expect(summaryReads).toBe(0);
		expect(finished).toEqual(["settled"]);
	});

	it("retains uncertain completion for an overload during Base list preparation", async () => {
		const finished: string[] = [];
		const gateway = {
			authorize: async () => ({
				ok: true as const,
				ticket: { id: "mcp-list-ticket", expires_at: 1_000 },
			}),
			readVault: async () => {
				throw new VaultOverloaded();
			},
			finishAdmission: async (
				_identity: unknown,
				_ticket: string,
				result: string,
			) => {
				finished.push(result);
				return { ok: true as const };
			},
		} as unknown as Parameters<typeof listMcpBases>[0];
		const outcome = await listMcpBases(gateway, identity);
		if (outcome.owner === undefined) throw new Error("Expected response owner");
		await outcome.owner.finish("settled");
		expect(outcome.owner.completion).toBe("uncertain");
		expect(finished).toEqual(["uncertain"]);
	});
});

describe("MCP note read cancellation", () => {
	it("joins a started blob read before the shared read slot can be reused", async () => {
		const started = barrier();
		const cancelStarted = barrier();
		const cancellationCleanup = barrier();
		const signal = new AbortController();
		const heldSlots = Array.from({ length: 4 }, () => tryAcquireReadSlot());
		expect(heldSlots.every((release) => release !== undefined)).toBe(true);
		const releaseRead = heldSlots[0];
		if (!releaseRead) throw new Error("Read slot was not acquired");
		const work = barrier();
		const store: BlobContentStore = {
			head: async () => undefined,
			putVerified: async ({ payload_hash, size }) => ({
				hash: payload_hash,
				size,
			}),
			read: async () =>
				new ReadableStream<Uint8Array>({
					/** Hold one started storage read until cancellation can join it. */
					pull() {
						started.resolve();
						return work.promise;
					},
					/** Wait for started source work and cancellation cleanup. */
					async cancel() {
						cancelStarted.resolve();
						await work.promise;
						await cancellationCleanup.promise;
					},
				}),
		};
		const gateway = {
			authorize: async () => ({
				ok: true as const,
				ticket: { id: "mcp-read-ticket", expires_at: 1_000 },
			}),
			readText: async () => ({
				ok: false as const,
				failure: { kind: "not_implemented" as const },
			}),
			readBlobMetadata: async () => ({
				ok: true as const,
				body: {
					path: "Agents/large.md",
					etag: '"0123456789abcdef0123456789abcdef.1"',
					hash: "a".repeat(64),
					size: 1_000_001,
					kind: "blob" as const,
					deleted: false,
					origin: "mcp-client",
					updated_at: 1,
					large: true,
				},
			}),
			finishAdmission: async () => ({ ok: true as const }),
		} satisfies Parameters<typeof readMcpNote>[0];
		let settled = false;
		const read = readMcpNote(
			gateway,
			identity,
			{ path: "Agents/large.md", offset: 0, length: 1 },
			store,
			signal.signal,
		).finally(() => {
			settled = true;
			releaseRead();
		});
		await started.promise;
		signal.abort();
		await cancelStarted.promise;
		expect(settled).toBe(false);
		expect(tryAcquireReadSlot()).toBeUndefined();
		work.resolve();
		expect(settled).toBe(false);
		expect(tryAcquireReadSlot()).toBeUndefined();
		cancellationCleanup.resolve();
		await expect(read).resolves.toMatchObject({
			ok: false,
			failure: { kind: "invalid_request" },
			owner: { completion: "settled" },
		});
		const reusedSlot = tryAcquireReadSlot();
		expect(reusedSlot).toBeDefined();
		reusedSlot?.();
		for (const release of heldSlots.slice(1)) release?.();
	});

	it("retains uncertain admission when a durable read rejects", async () => {
		const failure = new Error("read transport failed");
		let completion: string | undefined;
		const gateway = {
			authorize: async () => ({
				ok: true as const,
				ticket: { id: "mcp-read-ticket", expires_at: 1_000 },
			}),
			readText: async () => {
				throw failure;
			},
			readBlobMetadata: async () => {
				throw new Error("unexpected blob metadata read");
			},
			finishAdmission: async (_identity, _ticket, result) => {
				completion = result;
				return { ok: true as const };
			},
		} satisfies Parameters<typeof readMcpNote>[0];
		const store: BlobContentStore = {
			head: async () => undefined,
			putVerified: async ({ payload_hash, size }) => ({
				hash: payload_hash,
				size,
			}),
			read: async () => {
				throw new Error("unexpected blob content read");
			},
		};
		const outcome = await readMcpNote(
			gateway,
			identity,
			{ path: "Agents/read.md" },
			store,
		);
		expect(outcome).toMatchObject({
			ok: false,
			failure: { kind: "internal_error" },
			owner: { completion: "uncertain" },
		});
		expect(completion).toBeUndefined();
		if (outcome.owner) await outcome.owner.finish("settled");
		expect(completion).toBe("uncertain");
	});
});
