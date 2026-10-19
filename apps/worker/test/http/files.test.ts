import {
	env,
	evictDurableObject,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { TextReadResponseSchema } from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import {
	seedLiveTextState,
	TEXT_FIXTURE_EPOCH,
} from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

const url = "https://worker.invalid/v1/files/Note.md";

/** Pending request payload and release state used to observe durable reservation timing. */
type PendingBody = {
	body: ReadableStream<Uint8Array>;
	ready: Promise<void>;
	send: () => void;
	wasSent: () => boolean;
	wasCancelled: () => boolean;
	wasReadRequested: () => boolean;
};

/** Hold one real request body until the test releases its bytes. */
function createPendingBody(content: string): PendingBody {
	let release: (() => void) | undefined;
	let resolvePull: (() => void) | undefined;
	let markReady: (() => void) | undefined;
	let sent = false;
	let cancelled = false;
	let readRequested = false;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	const body = new ReadableStream<Uint8Array>(
		{
			/** Signal when a stream consumer requests body data. */
			pull(controller) {
				readRequested = true;
				markReady?.();
				return new Promise<void>((resolve) => {
					resolvePull = resolve;
					release = () => {
						sent = true;
						controller.enqueue(new TextEncoder().encode(content));
						controller.close();
						resolve();
					};
				});
			},
			/** Record cancellation and let any pending pull finish. */
			cancel() {
				cancelled = true;
				resolvePull?.();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		body,
		ready,
		send: () => release?.(),
		wasSent: () => sent,
		wasCancelled: () => cancelled,
		wasReadRequested: () => readRequested,
	};
}

/** Exercise conditional create, update, history, delete, and recreation through the Worker and real Vault binding. */
describe("conditional text HTTP lifecycle", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
			state.storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
				"http-revoked-grant",
				10,
			);
		});
	});
	it("waits for reader demand before signaling request-body readiness", async () => {
		const pending = createPendingBody("reader demanded these bytes");
		await Promise.resolve();
		expect(pending.wasReadRequested()).toBe(false);

		const reader = pending.body.getReader();
		const read = reader.read();
		await pending.ready;
		expect(pending.wasReadRequested()).toBe(true);
		pending.send();
		expect(new TextDecoder().decode((await read).value)).toBe(
			"reader demanded these bytes",
		);
	});

	it("uses decoded URL paths as the exact native file identity", async () => {
		/** Literal URL representations and independently specified canonical Vault paths. */
		const pathCases = [
			{ requestPath: "notes/100%25.md", path: "notes/100%.md" },
			{
				requestPath: "notes/literal%2520.md",
				path: "notes/literal%20.md",
			},
			{
				requestPath: "notes/literal%20.md",
				path: "notes/literal .md",
			},
			{
				requestPath: "notes/literal%252F.md",
				path: "notes/literal%2F.md",
			},
			{ requestPath: "notes/a%23b.md", path: "notes/a#b.md" },
			{ requestPath: "notes/a%3Fb.md", path: "notes/a?b.md" },
			{
				requestPath: "notes/caf%C3%A9%20notes.md",
				path: "notes/café notes.md",
			},
			{
				requestPath: "notes/nested%2Fchild.md",
				path: "notes/nested/child.md",
				plainPath: "notes/nested/child.md",
			},
		] as const;
		/** Build a test Worker URL from one raw path representation. */
		const fileUrl = (path: string) => `https://worker.invalid/v1/files/${path}`;

		for (const item of pathCases) {
			const encodedUrl = fileUrl(item.requestPath);
			const plainUrl = fileUrl(
				"plainPath" in item ? item.plainPath : item.requestPath,
			);
			const firstContent = `created:${item.path}`;
			const created = await SELF.fetch(encodedUrl, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: firstContent,
			});
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({ path: item.path });
			const firstEtag = created.headers.get("ETag");
			expect(firstEtag).toBeTypeOf("string");

			const firstRead = await SELF.fetch(plainUrl, {
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			});
			expect(firstRead.status).toBe(200);
			expect(
				TextReadResponseSchema.parse(await firstRead.json()),
			).toMatchObject({
				path: item.path,
				content: firstContent,
			});

			const updated = await SELF.fetch(plainUrl, {
				method: "PUT",
				headers: {
					"If-Match": firstEtag ?? "",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: `updated:${item.path}`,
			});
			expect(updated.status).toBe(200);
			expect(await updated.json()).toMatchObject({ path: item.path });
			const updatedEtag = updated.headers.get("ETag");
			expect(updatedEtag).toBeTypeOf("string");

			const historical = await SELF.fetch(`${encodedUrl}?rev=1`, {
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			});
			expect(historical.status).toBe(200);
			expect(
				TextReadResponseSchema.parse(await historical.json()),
			).toMatchObject({
				path: item.path,
				content: firstContent,
			});

			const deleted = await SELF.fetch(encodedUrl, {
				method: "DELETE",
				headers: { "If-Match": updatedEtag ?? "" },
			});
			expect(deleted.status).toBe(200);
			expect(await deleted.json()).toMatchObject({
				path: item.path,
				deleted: true,
			});
		}

		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const native = await runInDurableObject(stub, async (_instance, state) => ({
			paths: state.storage.sql
				.exec("SELECT path FROM files ORDER BY path")
				.toArray()
				.map((row) => row.path),
			revisions: state.storage.sql
				.exec("SELECT path, rev FROM revisions ORDER BY path, rev")
				.toArray(),
		}));
		const expectedPaths = pathCases.map((item) => item.path).sort();
		expect(native.paths).toEqual(expectedPaths);
		expect(new Set(native.paths).size).toBe(pathCases.length);
		expect(native.revisions).toEqual(
			expectedPaths.flatMap((path) => [1, 2, 3].map((rev) => ({ path, rev }))),
		);
		for (const item of pathCases)
			if (!expectedPaths.some((path) => path === item.requestPath))
				expect(native.paths).not.toContain(item.requestPath);

		const beforeInvalid = native;
		for (const requestPath of [
			"notes/bad%ZZ.md",
			"notes/bad%.md",
			"notes/%2e%2Fdot.md",
			"notes/%2e%2e%2Fescape.md",
			"notes/back%5Cslash.md",
			"notes//empty-segment.md",
			"notes/%2Fleading-segment.md",
		]) {
			const invalid = await SELF.fetch(fileUrl(requestPath), {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "must not publish",
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ error: "invalid_path" });
		}
		const afterInvalid = await runInDurableObject(
			stub,
			async (_instance, state) => ({
				paths: state.storage.sql
					.exec("SELECT path FROM files ORDER BY path")
					.toArray()
					.map((row) => row.path),
				revisions: state.storage.sql
					.exec("SELECT path, rev FROM revisions ORDER BY path, rev")
					.toArray(),
			}),
		);
		expect(afterInvalid).toEqual(beforeInvalid);
	});

	it("publishes exact bytes and retains each observed revision", async () => {
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": "0123456789abcdef0123456789abcdef",
			},
			body: "first text",
		});
		expect(created.status).toBe(201);
		const firstEtag = created.headers.get("ETag");
		expect(firstEtag).toBe('"0123456789abcdef0123456789abcdef.1"');
		const first = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": "0123456789abcdef0123456789abcdef" },
		});
		expect(first.status).toBe(200);
		expect(TextReadResponseSchema.parse(await first.json()).content).toBe(
			"first text",
		);

		const updated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": firstEtag ?? "",
				"X-Vault-Epoch": "0123456789abcdef0123456789abcdef",
			},
			body: "second text",
		});
		expect(updated.status).toBe(200);
		const secondEtag = updated.headers.get("ETag");
		const history = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": "0123456789abcdef0123456789abcdef" },
		});
		expect(history.status).toBe(200);
		expect(TextReadResponseSchema.parse(await history.json()).content).toBe(
			"first text",
		);
		expect(history.headers.get("ETag")).toBe(firstEtag);

		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": secondEtag ?? "" },
		});
		expect(deleted.status).toBe(200);
		const recreated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": "0123456789abcdef0123456789abcdef",
			},
			body: "third text",
		});
		expect(recreated.status).toBe(201);
		expect(recreated.headers.get("ETag")).toBe(
			'"0123456789abcdef0123456789abcdef.4"',
		);
	});

	it("returns the authoritative epoch before it reads a missing observation body", async () => {
		const request = new Request(url, {
			method: "PUT",
			headers: { "If-None-Match": "*" },
			body: "not consumed",
		});
		const response = await testWorker.fetch(request, env);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "epoch_mismatch",
			current_epoch: "0123456789abcdef0123456789abcdef",
		});
		expect(request.bodyUsed).toBe(false);
	});

	it("checks the intended operation scope and revocation before returning epoch metadata", async () => {
		const writeOnly = await SELF.fetch(url, {
			method: "PUT",
			headers: { "X-Test-Identity": "write", "If-None-Match": "*" },
			body: "ignored",
		});
		expect(writeOnly.status).toBe(409);
		expect(await writeOnly.json()).toMatchObject({
			current_epoch: "0123456789abcdef0123456789abcdef",
		});

		const missingScope = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"X-Test-Identity": "read",
				"If-None-Match": "*",
				"X-Vault-Epoch": "0123456789abcdef0123456789abcdef",
			},
			body: "ignored",
		});
		expect(missingScope.status).toBe(403);

		const revoked = await SELF.fetch(url, {
			method: "PUT",
			headers: { "X-Test-Identity": "revoked", "If-None-Match": "*" },
			body: "ignored",
		});
		expect(revoked.status).toBe(401);
	});

	it("keeps replacement ownership after an expired body completes late", async () => {
		const firstBody = createPendingBody("first body");
		const first = testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "slow-key-0001",
				},
				body: firstBody.body,
			}),
			env,
		);
		await firstBody.ready;
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const owner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"slow-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(owner).toBeTypeOf("string");
		expect(firstBody.wasSent()).toBe(false);
		const duplicate = await testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "slow-key-0001",
				},
			}),
			env,
		);
		expect(duplicate.status).toBe(409);
		expect(firstBody.wasSent()).toBe(false);

		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE operation_admissions SET expires_at = ? WHERE id = ?",
				Date.now() - 1,
				owner,
			);
		});
		const replacementBody = createPendingBody("replacement body");
		const replacement = testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "slow-key-0001",
				},
				body: replacementBody.body,
			}),
			env,
		);
		await replacementBody.ready;
		const replacementOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"slow-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(replacementOwner).not.toBe(owner);
		firstBody.send();
		expect((await first).status).toBe(409);
		const retainedOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"slow-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(retainedOwner).toBe(replacementOwner);
		replacementBody.send();
		expect((await replacement).status).toBe(201);
	});

	it("cancels an expired body without settling its replacement claim", async () => {
		const originalBody = createPendingBody("cancelled original");
		const abort = new AbortController();
		const first = testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "cancel-key-0001",
				},
				body: originalBody.body,
				signal: abort.signal,
			}),
			env,
		);
		await originalBody.ready;
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const originalOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"cancel-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(originalOwner).toBeTypeOf("string");
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE operation_admissions SET expires_at = ? WHERE id = ?",
				Date.now() - 1,
				originalOwner,
			);
		});

		const replacementBody = createPendingBody(
			"replacement survives cancellation",
		);
		const replacement = testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "cancel-key-0001",
				},
				body: replacementBody.body,
			}),
			env,
		);
		await replacementBody.ready;
		const replacementOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"cancel-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(replacementOwner).not.toBe(originalOwner);
		abort.abort();
		expect((await first).status).toBe(400);
		expect(originalBody.wasCancelled()).toBe(true);
		const retained = await runInDurableObject(
			stub,
			async (_instance, state) => ({
				owner: state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"cancel-key-0001",
					)
					.toArray()[0]?.admission_id,
				revisions: state.storage.sql.exec("SELECT * FROM revisions").toArray(),
			}),
		);
		expect(retained.owner).toBe(replacementOwner);
		expect(retained.revisions).toHaveLength(0);
		replacementBody.send();
		expect((await replacement).status).toBe(201);
	});

	it("preserves a slow keyed reservation across real Durable Object eviction", async () => {
		const body = createPendingBody("after eviction");
		const first = testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "evict-key-0001",
				},
				body: body.body,
			}),
			env,
		);
		await body.ready;
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const priorOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"evict-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(priorOwner).toBeTypeOf("string");
		expect(body.wasSent()).toBe(false);

		await evictDurableObject(stub);
		const duplicateRequest = new Request(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"Idempotency-Key": "evict-key-0001",
			},
		});
		const duplicate = await testWorker.fetch(duplicateRequest, env);
		expect(duplicate.status).toBe(409);
		expect(duplicateRequest.bodyUsed).toBe(false);
		expect(body.wasSent()).toBe(false);

		const restoredOwner = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT admission_id FROM mutation_claims WHERE key = ?",
						"evict-key-0001",
					)
					.toArray()[0]?.admission_id,
		);
		expect(restoredOwner).toBe(priorOwner);
		body.send();
		expect((await first).status).toBe(201);
	});

	it("rejects repeated selectors, unsupported methods, and actual bytes over the ceiling", async () => {
		const repeated = await SELF.fetch(`${url}?rev=1&rev=2`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(repeated.status).toBe(400);
		const unsupported = await SELF.fetch(url, { method: "POST" });
		expect(unsupported.status).toBe(404);

		const oversized = await testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Content-Length": "1",
				},
				body: new Uint8Array(1_000_001).fill(97),
			}),
			env,
		);
		expect(oversized.status).toBe(413);
	});

	it("rejects unexpected DELETE bodies without consuming them", async () => {
		const response = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": '"0123456789abcdef0123456789abcdef.1"' },
			body: "unexpected",
		});
		expect(response.status).toBe(400);
	});

	it("rejects old epochs, stale ETags, and canonical path collisions", async () => {
		const oldEpoch = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
			body: "old",
		});
		expect(oldEpoch.status).toBe(409);
		expect(await oldEpoch.json()).toMatchObject({
			current_epoch: "0123456789abcdef0123456789abcdef",
		});

		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "one",
		});
		const etag = created.headers.get("ETag") ?? "";
		await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-Match": etag, "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "two",
		});
		const stale = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-Match": etag, "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "stale",
		});
		expect(stale.status).toBe(412);

		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
			await seedLiveTextState(state.storage, {
				path: "notes/CAFÉ.md",
				content: "existing",
			});
		});
		const collision = await SELF.fetch(
			"https://worker.invalid/v1/files/Notes/café.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "collision",
			},
		);
		expect(collision.status).toBe(409);
		expect(await collision.json()).toMatchObject({
			error: "path_collision",
			existing_path: "notes/CAFÉ.md",
		});
	});

	it("replays the original receipt after the client retries the same key and bytes", async () => {
		const headers = {
			"If-None-Match": "*",
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			"Idempotency-Key": "replay-key-0001",
		};
		const first = await SELF.fetch(url, {
			method: "PUT",
			headers,
			body: "retry bytes",
		});
		const retry = await SELF.fetch(url, {
			method: "PUT",
			headers,
			body: "retry bytes",
		});
		expect(first.status).toBe(201);
		expect(retry.status).toBe(201);
		expect(retry.headers.get("ETag")).toBe(first.headers.get("ETag"));
		const history = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(history.status).toBe(200);
	});

	it("retries through HTTP after the test entry loses a committed RPC response", async () => {
		const headers = {
			"If-None-Match": "*",
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			"Idempotency-Key": "lost-response-001",
			"X-Test-Lose-Commit-Response": "true",
		};
		const lost = await testWorker.fetch(
			new Request(url, { method: "PUT", headers, body: "original bytes" }),
			env,
		);
		expect(lost.status).toBe(500);
		const retry = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"Idempotency-Key": "lost-response-001",
			},
			body: "original bytes",
		});
		expect(retry.status).toBe(201);
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const counts = await runInDurableObject(stub, async (_instance, state) => ({
			revisions: state.storage.sql
				.exec("SELECT * FROM revisions WHERE path = ?", "Note.md")
				.toArray(),
			receipts: state.storage.sql
				.exec("SELECT * FROM receipts WHERE key = ?", "lost-response-001")
				.toArray(),
		}));
		expect(counts.revisions).toHaveLength(1);
		expect(counts.receipts).toHaveLength(1);
	});

	it("settles a reservation when body delivery fails", async () => {
		const body = new ReadableStream<Uint8Array>({
			/** Fail delivery so the Worker must settle its reservation. */
			start(controller) {
				controller.error(new Error("body failed"));
			},
		});
		const response = await testWorker.fetch(
			new Request(url, {
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body,
			}),
			env,
		);
		expect(response.status).toBe(400);
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const state = await runInDurableObject(
			stub,
			async (_instance, objectState) => ({
				admissions: objectState.storage.sql
					.exec("SELECT * FROM operation_admissions")
					.toArray(),
				files: objectState.storage.sql.exec("SELECT * FROM files").toArray(),
			}),
		);
		expect(state.admissions).toHaveLength(0);
		expect(state.files).toHaveLength(0);
	});

	it("returns canonical internal errors for unknown authority RPC outcomes", async () => {
		const epochLookup = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Test-Fail-RPC": "getCurrentEpoch" },
			body: "not read",
		});
		expect(epochLookup.status).toBe(500);
		expect(await epochLookup.json()).toEqual({
			error: "internal_error",
			message: "The service cannot complete the request.",
		});

		const begin = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Test-Fail-RPC": "beginMutation",
			},
			body: "not read",
		});
		expect(begin.status).toBe(500);
		expect(await begin.json()).toEqual({
			error: "internal_error",
			message: "The service cannot complete the request.",
		});

		const authorize = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Test-Fail-RPC": "authorize",
			},
			body: "authorize bytes",
		});
		expect(authorize.status).toBe(500);
		expect(await authorize.json()).toEqual({
			error: "internal_error",
			message: "The service cannot complete the request.",
		});

		const read = await SELF.fetch(url, {
			headers: { "X-Test-Fail-RPC": "readText" },
		});
		expect(read.status).toBe(500);
		expect(await read.json()).toEqual({
			error: "internal_error",
			message: "The service cannot complete the request.",
		});

		const settle = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Test-Fail-RPC": "finishAdmission",
			},
			body: "committed bytes",
		});
		expect(settle.status).toBe(201);
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const state = await runInDurableObject(
			stub,
			async (_instance, objectState) => ({
				admissionStates: objectState.storage.sql
					.exec("SELECT state FROM operation_admissions")
					.toArray()
					.map((row) => row.state),
				revisions: objectState.storage.sql
					.exec("SELECT * FROM revisions")
					.toArray(),
			}),
		);
		expect(state.admissionStates).toContain("reserved");
		expect(state.admissionStates).toContain("uncertain");
		expect(state.revisions).toHaveLength(1);
	});

	it("returns epoch mismatch for malformed observations and historical reads without a header", async () => {
		const malformed = await SELF.fetch(url, {
			method: "PUT",
			body: "no condition",
		});
		expect(malformed.status).toBe(400);
		const malformedEpoch = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": "invalid" },
			body: "ignored",
		});
		expect(malformedEpoch.status).toBe(409);
		expect(await malformedEpoch.json()).toMatchObject({
			current_epoch: "0123456789abcdef0123456789abcdef",
		});
		const historical = await SELF.fetch(`${url}?rev=1`);
		expect(historical.status).toBe(409);
		expect(await historical.json()).toMatchObject({
			current_epoch: "0123456789abcdef0123456789abcdef",
		});
	});
});
