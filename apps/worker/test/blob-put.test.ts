import { env, runInDurableObject } from "cloudflare:test";
import type {
	AuthorizationContext,
	BlobDeclaration,
	TextMutationDescriptor,
} from "@obsidian-ai-bridge/protocol";
import {
	type BlobPutGateway,
	type BlobStore,
	executeBlobPut,
} from "@worker/application/blobs";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import { FileOperationDenied } from "@worker/application/files";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Identity shared by real authority calls, separate from the production entry. */
const identity: AuthorizationContext = {
	client_id: "blob-client",
	grant_id: "blob-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};
/** A small invalid-UTF-8 fixture verifies the binary path without text conversion. */
const bytes = new Uint8Array([255, 0, 128, 1]);
/** Real authority selected by a stable, test-only host. */
const stub = env.VAULTS.get(
	env.VAULTS.idFromName("blob-orchestration.invalid"),
);
/** Forward only the authority calls the application upload needs. */
function gateway(overrides: Partial<BlobPutGateway> = {}): BlobPutGateway {
	return {
		beginMutation: (...args) => stub.beginMutation(...args),
		authorizeBlob: (...args) => stub.authorizeBlob(...args),
		commitBlob: (...args) => stub.commitBlob(...args),
		finishAdmission: (...args) => stub.finishAdmission(...args),
		...overrides,
	};
}
/** Resolve controlled waits without a timer or detached work. */
function gate() {
	/** Default release stays inert until the Promise executor installs its resolver. */
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
/** Hash test input without trusting upload evidence. */
async function declaration(input = bytes): Promise<BlobDeclaration> {
	const hash = await crypto.subtle.digest("SHA-256", input.slice());
	return {
		payload_hash: Array.from(new Uint8Array(hash), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
		size: input.byteLength,
	};
}
/** Create-only intent with an exact epoch observation. */
function descriptor(path = "native.bin"): TextMutationDescriptor {
	return {
		op: "put",
		paths: [path],
		epoch: TEXT_FIXTURE_EPOCH,
		precondition: { kind: "absent" },
	};
}
/** Read publication effects and admission deadlines from the native authority. */
async function effects() {
	return runInDurableObject(stub, async (_instance, state) => ({
		revisions: state.storage.sql.exec("SELECT * FROM revisions").toArray(),
		changes: state.storage.sql.exec("SELECT * FROM changes").toArray(),
		receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
		admissions: state.storage.sql
			.exec("SELECT id, state, expires_at FROM operation_admissions")
			.toArray(),
	}));
}
/** Exact declaration binding, effect certainty, and slot lifetime use actual local R2. */
describe("executeBlobPut", () => {
	beforeEach(async () => {
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
		});
	});
	it("gets full authority before storage or body demand", async () => {
		const entered = gate();
		const resume = gate();
		let storageCalls = 0;
		let bodyDemand = 0;
		const store = new R2BlobStore(env.R2_BUCKET);
		const port: BlobStore = {
			head: (hash) => store.head(hash),
			putVerified: async (...args) => {
				storageCalls++;
				return store.putVerified(...args);
			},
		};
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Demand bytes only after the upload receives complete authority. */
			pull(controller) {
				bodyDemand++;
				controller.enqueue(bytes.slice());
				controller.close();
			},
		});
		const upload = executeBlobPut(
			gateway({
				authorizeBlob: async (...args) => {
					entered.release();
					await resume.promise;
					return stub.authorizeBlob(...args);
				},
			}),
			port,
			identity,
			descriptor(),
			undefined,
			await declaration(),
			body,
			new AbortController().signal,
		);
		await entered.promise;
		try {
			expect(storageCalls).toBe(0);
			expect(bodyDemand).toBe(0);
		} finally {
			resume.release();
			await upload;
		}
		expect((await upload).ok).toBe(true);
		expect(storageCalls).toBe(1);
	});
	it("replays a receipt with current policy and no redundant storage or body work", async () => {
		const store = new R2BlobStore(env.R2_BUCKET);
		const declared = await declaration();
		const first = await executeBlobPut(
			gateway(),
			store,
			identity,
			descriptor(),
			"blob-replay-key",
			declared,
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(first.ok).toBe(true);
		let calls = 0;
		const failStore: BlobStore = {
			head: async () => {
				calls++;
				throw new Error("Unexpected storage");
			},
			putVerified: async () => {
				calls++;
				throw new Error("Unexpected upload");
			},
		};
		const body = new Blob([bytes]).stream();
		const retry = await executeBlobPut(
			gateway(),
			failStore,
			identity,
			descriptor(),
			"blob-replay-key",
			declared,
			body,
			new AbortController().signal,
		);
		expect(retry).toEqual(first);
		expect(calls).toBe(0);
		expect(body.locked).toBe(false);
		const state = await effects();
		expect(state.revisions).toHaveLength(1);
		expect(state.changes).toHaveLength(1);
		expect(state.receipts).toHaveLength(1);
		const different = await executeBlobPut(
			gateway(),
			failStore,
			identity,
			descriptor(),
			"blob-replay-key",
			{ ...declared, size: 3 },
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(different).toMatchObject({
			ok: false,
			failure: { kind: "idempotency_mismatch" },
		});
		await runInDurableObject(stub, async (_instance, objectState) => {
			objectState.storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
				identity.grant_id,
				10,
			);
		});
		expect(
			await executeBlobPut(
				gateway(),
				failStore,
				identity,
				descriptor(),
				"blob-replay-key",
				declared,
				new Blob([bytes]).stream(),
				new AbortController().signal,
			),
		).toMatchObject({ ok: false, failure: { kind: "revoked" } });
		expect(calls).toBe(0);
	});
	describe.each(["storage", "authorize", "commit"] as const)(
		"%s wait",
		(stage) => {
			it.each(["revoked", "expired", "epoch", "stale"] as const)(
				"blocks publication after %s",
				async (event) => {
					const entered = gate();
					const resume = gate();
					const native = new R2BlobStore(env.R2_BUCKET);
					const declared = await declaration();
					const store: BlobStore = {
						head: (hash) => native.head(hash),
						putVerified: async (...args) => {
							const evidence = await native.putVerified(...args);
							if (stage === "storage") {
								entered.release();
								await resume.promise;
							}
							return evidence;
						},
					};
					const authority = gateway({
						authorizeBlob: async (...args) => {
							const result = await stub.authorizeBlob(...args);
							if (stage === "authorize") {
								entered.release();
								await resume.promise;
							}
							return result;
						},
						commitBlob: async (...args) => {
							if (stage === "commit") {
								entered.release();
								await resume.promise;
							}
							return stub.commitBlob(...args);
						},
					});
					const upload = executeBlobPut(
						authority,
						store,
						identity,
						descriptor(),
						undefined,
						declared,
						new Blob([bytes]).stream(),
						new AbortController().signal,
					);
					await entered.promise;
					await runInDurableObject(stub, async (_instance, state) => {
						if (event === "revoked")
							state.storage.sql.exec(
								"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
								identity.grant_id,
								10,
							);
						if (event === "expired")
							state.storage.sql.exec(
								"UPDATE operation_admissions SET expires_at = ?",
								Date.now() - 1,
							);
						if (event === "epoch")
							state.storage.sql.exec(
								"UPDATE meta SET value = ? WHERE key = 'epoch'",
								"a".repeat(32),
							);
					});
					if (event === "stale") {
						const second = await executeBlobPut(
							gateway(),
							native,
							{ ...identity, client_id: "competitor" },
							descriptor(),
							undefined,
							declared,
							new Blob([bytes]).stream(),
							new AbortController().signal,
						);
						expect(second.ok).toBe(true);
					}
					resume.release();
					const result = await upload;
					expect(result).toMatchObject({
						ok: false,
						failure: {
							kind:
								event === "revoked"
									? "revoked"
									: event === "epoch"
										? "epoch_mismatch"
										: event === "stale"
											? "precondition_failed"
											: "invalid_ticket",
						},
					});
					const state = await effects();
					expect(state.revisions).toHaveLength(event === "stale" ? 1 : 0);
					expect(state.changes).toHaveLength(event === "stale" ? 1 : 0);
					expect(state.receipts).toHaveLength(0);
					const stored = await env.R2_BUCKET.get(
						`blobs/${declared.payload_hash}`,
					);
					if (!stored)
						throw new Error("Expected authorized orphan or committed bytes");
					expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
				},
			);
		},
	);

	it("retains uncertain storage ownership and retries exact bytes after the original deadline", async () => {
		const native = new R2BlobStore(env.R2_BUCKET);
		const declared = await declaration();
		const store: BlobStore = {
			head: (hash) => native.head(hash),
			putVerified: async (...args) => {
				await native.putVerified(...args);
				throw new FileOperationDenied({
					kind: "blob_storage_unavailable",
					retry_after_seconds: 1,
				});
			},
		};
		const result = await executeBlobPut(
			gateway(),
			store,
			identity,
			descriptor(),
			"lost-storage-result",
			declared,
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "blob_storage_unavailable" },
		});
		const before = await effects();
		expect(before.admissions).toHaveLength(1);
		expect(before.admissions[0]?.state).toBe("uncertain");
		expect(before.revisions).toHaveLength(0);
		const blocked = await executeBlobPut(
			gateway(),
			native,
			identity,
			descriptor(),
			"lost-storage-result",
			declared,
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(blocked).toMatchObject({
			ok: false,
			failure: { kind: "idempotency_in_progress" },
		});
		expect((await effects()).admissions).toEqual(before.admissions);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE operation_admissions SET expires_at = ?",
				Date.now() - 1,
			);
		});
		const retry = await executeBlobPut(
			gateway(),
			native,
			identity,
			descriptor(),
			"lost-storage-result",
			declared,
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(retry.ok).toBe(true);
		const after = await effects();
		expect(after.revisions).toHaveLength(1);
		expect(after.changes).toHaveLength(1);
		expect(after.receipts).toHaveLength(1);
		const stored = await env.R2_BUCKET.get(`blobs/${declared.payload_hash}`);
		if (!stored) throw new Error("Expected immutable object");
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
	});
	it("retries a lost committed authority result without a second storage access", async () => {
		const native = new R2BlobStore(env.R2_BUCKET);
		const declared = await declaration();
		const authority = gateway({
			commitBlob: async (...args) => {
				const result = await stub.commitBlob(...args);
				expect(result.ok).toBe(true);
				throw new Error("Lost committed result");
			},
		});
		await expect(
			executeBlobPut(
				authority,
				native,
				identity,
				descriptor(),
				"lost-authority-result",
				declared,
				new Blob([bytes]).stream(),
				new AbortController().signal,
			),
		).rejects.toThrow("Lost committed result");
		const failStore: BlobStore = {
			head: async () => {
				throw new Error("Unexpected storage");
			},
			putVerified: async () => {
				throw new Error("Unexpected storage");
			},
		};
		expect(
			(
				await executeBlobPut(
					gateway(),
					failStore,
					identity,
					descriptor(),
					"lost-authority-result",
					declared,
					new Blob([bytes]).stream(),
					new AbortController().signal,
				)
			).ok,
		).toBe(true);
		const state = await effects();
		expect(state.revisions).toHaveLength(1);
		expect(state.changes).toHaveLength(1);
		expect(state.receipts).toHaveLength(1);
	});
	it.each(["authorize", "storage", "commit", "finish"] as const)(
		"holds its slot after abort until non-cancellable %s settles",
		async (stage) => {
			const entered = gate();
			const resume = gate();
			const native = new R2BlobStore(env.R2_BUCKET);
			const declared = await declaration();
			const abort = new AbortController();
			const store: BlobStore = {
				head: (hash) => native.head(hash),
				putVerified: async (...args) => {
					const result = await native.putVerified(...args);
					if (stage === "storage") {
						entered.release();
						await resume.promise;
					}
					return result;
				},
			};
			const authority = gateway({
				authorizeBlob: async (...args) => {
					const result = await stub.authorizeBlob(...args);
					if (stage === "authorize") {
						entered.release();
						await resume.promise;
					}
					return result;
				},
				commitBlob: async (...args) => {
					if (stage === "commit") {
						entered.release();
						await resume.promise;
					}
					return stub.commitBlob(...args);
				},
				finishAdmission: async (...args) => {
					if (stage === "finish") {
						entered.release();
						await resume.promise;
					}
					return stub.finishAdmission(...args);
				},
			});
			const upload = executeBlobPut(
				authority,
				store,
				identity,
				descriptor(),
				"abort-key-0001",
				declared,
				new Blob([bytes]).stream(),
				abort.signal,
			);
			await entered.promise;
			abort.abort();
			const held = [
				tryAcquireBodySlot(),
				tryAcquireBodySlot(),
				tryAcquireBodySlot(),
			];
			try {
				expect(held.every((release) => release !== undefined)).toBe(true);
				expect(tryAcquireBodySlot()).toBeUndefined();
			} finally {
				resume.release();
				for (const release of held) release?.();
			}
			const result = await upload;
			expect(result.ok).toBe(stage === "commit" || stage === "finish");
			const state = await effects();
			expect(state.revisions).toHaveLength(
				stage === "storage" || stage === "authorize" ? 0 : 1,
			);
			expect(state.admissions).toHaveLength(0);
			if (stage === "storage") {
				const retry = await executeBlobPut(
					gateway(),
					native,
					identity,
					descriptor(),
					"abort-key-0001",
					declared,
					new Blob([bytes]).stream(),
					new AbortController().signal,
				);
				expect(retry.ok).toBe(true);
				expect((await effects()).revisions).toHaveLength(1);
			}
			const release = tryAcquireBodySlot();
			expect(release).toBeTypeOf("function");
			release?.();
		},
	);
	it("uses at most four authority calls for a new keyed upload", async () => {
		let calls = 0;
		const authority = gateway({
			beginMutation: async (...args) => {
				calls++;
				return stub.beginMutation(...args);
			},
			authorizeBlob: async (...args) => {
				calls++;
				return stub.authorizeBlob(...args);
			},

			commitBlob: async (...args) => {
				calls++;
				return stub.commitBlob(...args);
			},
			finishAdmission: async (...args) => {
				calls++;
				return stub.finishAdmission(...args);
			},
		});
		const result = await executeBlobPut(
			authority,
			new R2BlobStore(env.R2_BUCKET),
			identity,
			descriptor(),
			"authority-call-budget",
			await declaration(),
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		expect(result.ok).toBe(true);
		expect(calls).toBeLessThanOrEqual(4);
	});
	it("preserves one immutable object and one revision in a same-hash client race", async () => {
		const declared = await declaration();
		const native = new R2BlobStore(env.R2_BUCKET);
		const results = await Promise.all(
			[0, 1].map((index) =>
				executeBlobPut(
					gateway(),
					native,
					{ ...identity, client_id: `racing-client-${index}` },
					descriptor(),
					undefined,
					declared,
					new Blob([bytes]).stream(),
					new AbortController().signal,
				),
			),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.find((result) => !result.ok)).toMatchObject({
			failure: { kind: "precondition_failed" },
		});
		const state = await effects();
		expect(state.revisions).toHaveLength(1);
		expect(state.changes).toHaveLength(1);
		const stored = await env.R2_BUCKET.get(`blobs/${declared.payload_hash}`);
		if (!stored) throw new Error("Expected immutable bytes");
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
	});
	it("retains uncertainty after body cancellation without changing an existing object", async () => {
		const entered = gate();
		const resume = gate();
		const declared = await declaration();
		await env.R2_BUCKET.put(`blobs/${declared.payload_hash}`, bytes, {
			sha256: declared.payload_hash,
		});
		let demand = 0;
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Hold source delivery until cancellation stops the owned read. */
			async pull() {
				demand++;
				entered.release();
				await resume.promise;
			},
		});
		const abort = new AbortController();
		const upload = executeBlobPut(
			gateway(),
			new R2BlobStore(env.R2_BUCKET),
			identity,
			descriptor(),
			"body-cancel-key",
			declared,
			body,
			abort.signal,
		);
		await entered.promise;
		abort.abort();
		resume.release();
		const result = await upload;
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "blob_storage_unavailable" },
		});
		expect(demand).toBe(1);
		const state = await effects();
		expect(state.admissions).toHaveLength(1);
		expect(state.admissions[0]?.state).toBe("uncertain");
		expect(state.revisions).toHaveLength(0);
		const stored = await env.R2_BUCKET.get(`blobs/${declared.payload_hash}`);
		if (!stored) throw new Error("Expected preserved immutable bytes");
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
	});
	it("keeps the slot after ticket expiry until started storage delivery settles", async () => {
		const entered = gate();
		const resume = gate();
		const declared = await declaration();
		const native = new R2BlobStore(env.R2_BUCKET);
		const store: BlobStore = {
			head: (hash) => native.head(hash),
			putVerified: async (...args) => {
				const evidence = await native.putVerified(...args);
				entered.release();
				await resume.promise;
				return evidence;
			},
		};
		const upload = executeBlobPut(
			gateway(),
			store,
			identity,
			descriptor(),
			undefined,
			declared,
			new Blob([bytes]).stream(),
			new AbortController().signal,
		);
		await entered.promise;
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE operation_admissions SET expires_at = ?",
				Date.now() - 1,
			);
		});
		const held = [
			tryAcquireBodySlot(),
			tryAcquireBodySlot(),
			tryAcquireBodySlot(),
		];
		try {
			expect(held.every((release) => release !== undefined)).toBe(true);
			expect(tryAcquireBodySlot()).toBeUndefined();
		} finally {
			resume.release();
			for (const release of held) release?.();
		}
		expect(await upload).toMatchObject({
			ok: false,
			failure: { kind: "invalid_ticket" },
		});
		expect((await effects()).revisions).toHaveLength(0);
	});
	it.each([undefined, "wrong-owner-key"])(
		"rejects mismatched key ownership %s before storage",
		async (key) => {
			const declared = await declaration();
			let uploads = 0;
			const native = new R2BlobStore(env.R2_BUCKET);
			const store: BlobStore = {
				head: (hash) => native.head(hash),
				putVerified: async (...args) => {
					uploads++;
					return native.putVerified(...args);
				},
			};
			const authority = gateway({
				beginMutation: (context, descriptor) =>
					stub.beginMutation(context, descriptor, "actual-owner-key"),
			});
			const result = await executeBlobPut(
				authority,
				store,
				identity,
				descriptor(),
				key,
				declared,
				new Blob([bytes]).stream(),
				new AbortController().signal,
			);
			expect(result).toMatchObject({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect(uploads).toBe(0);
			expect((await effects()).revisions).toHaveLength(0);
		},
	);
});
