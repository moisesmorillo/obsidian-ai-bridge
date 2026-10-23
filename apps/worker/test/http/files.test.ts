import {
	env,
	evictDurableObject,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import {
	encodeFileFailure,
	MutationSuccessSchema,
	TextReadResponseSchema,
} from "@obsidian-ai-bridge/protocol";
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

/** Hash the escaped fixture response with bounded writes, without a complete JSON fixture allocation. */
async function escapedFailureDigest(
	emptyBody: string,
	marker: number,
): Promise<ArrayBuffer> {
	const digest = new (
		crypto as Crypto & { DigestStream: typeof DigestStream }
	).DigestStream("SHA-256");
	const writer = digest.getWriter();
	const encoder = new TextEncoder();
	// Canonical encoding places this fixture's content last. Remove its closing quote and brace only.
	expect(emptyBody.endsWith('"content":""}')).toBe(true);
	await writer.write(encoder.encode(emptyBody.slice(0, -2)));
	const chunk = encoder.encode("\\u0000".repeat(8_192));
	for (let count = 0; count < 999_999; count += 8_192) {
		await writer.write(chunk.subarray(0, Math.min(8_192, 999_999 - count) * 6));
	}
	await writer.write(encoder.encode(`${marker}"}`));
	await writer.close();
	return digest.digest;
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
		await created.text();
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
		await updated.text();
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
		await recreated.text();
	});

	it("accepts a current DELETE epoch and rejects a stale epoch without changing bytes", async () => {
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "authoritative bytes",
		});
		const etag = created.headers.get("ETag");
		await created.text();
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const before = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql
				.exec("SELECT path, rev, hash, deleted, seq FROM files ORDER BY path")
				.toArray(),
		);
		const malformed = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": etag ?? "", "X-Vault-Epoch": "invalid" },
		});
		expect(malformed.status).toBe(400);
		const conflicting = await SELF.fetch(url, {
			method: "DELETE",
			headers: {
				"If-Match": etag ?? "",
				"X-Vault-Epoch": "fedcba9876543210fedcba9876543210",
			},
		});
		expect(conflicting.status).toBe(400);
		const scopeDenied = await SELF.fetch(url, {
			method: "DELETE",
			headers: {
				"X-Test-Identity": "write",
				"If-Match": etag ?? "",
				"X-Vault-Epoch": "invalid",
			},
		});
		expect(scopeDenied.status).toBe(403);
		const revoked = await SELF.fetch(url, {
			method: "DELETE",
			headers: {
				"X-Test-Identity": "revoked",
				"If-Match": etag ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
		});
		expect(revoked.status).toBe(401);

		const staleEpoch = "fedcba9876543210fedcba9876543210";
		const stale = await SELF.fetch(url, {
			method: "DELETE",
			headers: {
				"If-Match": `"${staleEpoch}.1"`,
				"X-Vault-Epoch": staleEpoch,
			},
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ error: "epoch_mismatch" });
		const after = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql
				.exec("SELECT path, rev, hash, deleted, seq FROM files ORDER BY path")
				.toArray(),
		);
		expect(after).toEqual(before);
		const current = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": etag ?? "", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(current.status).toBe(200);
	});

	it("returns revision_pruned when a historical read omits the epoch", async () => {
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "revision one",
		});
		await created.text();
		const historical = await SELF.fetch(`${url}?rev=1`);
		expect(historical.status).toBe(410);
		expect(await historical.json()).toMatchObject({ error: "revision_pruned" });
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
		await duplicate.text();
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
		const firstResponse = await first;
		expect(firstResponse.status).toBe(409);
		await firstResponse.text();
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
		const replacementResponse = await replacement;
		expect(replacementResponse.status).toBe(201);
		await replacementResponse.text();
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
		const firstResponse = await first;
		expect(firstResponse.status).toBe(400);
		await firstResponse.text();
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
		const replacementResponse = await replacement;
		expect(replacementResponse.status).toBe(201);
		await replacementResponse.text();
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
		await duplicate.text();
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
		const firstResponse = await first;
		expect(firstResponse.status).toBe(201);
		await firstResponse.text();
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
		await oversized.text();
	});

	it("rejects unexpected DELETE bodies without consuming them", async () => {
		const response = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": '"0123456789abcdef0123456789abcdef.1"' },
			body: "unexpected",
		});
		expect(response.status).toBe(400);
	});

	it("AC-03/04/05/06 server: one concurrent mutation wins against one observed revision", async () => {
		const source = "https://worker.invalid/v1/files/notes/race-source.md";
		const created = await SELF.fetch(source, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "base",
		});
		const observedTag = created.headers.get("ETag") ?? "";
		await created.text();
		const sharedHeaders = {
			"If-Match": observedTag,
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
		};
		const [write, deletion, rename] = await Promise.all([
			SELF.fetch(source, {
				method: "PUT",
				headers: sharedHeaders,
				body: "write",
			}),
			SELF.fetch(source, { method: "DELETE", headers: sharedHeaders }),
			SELF.fetch(`${source}:rename`, {
				method: "POST",
				headers: sharedHeaders,
				body: JSON.stringify({ to: "notes/race-destination.md" }),
			}),
		]);
		const responses = [write, deletion, rename];
		const bodies = await Promise.all(
			responses.map((response) => response.text()),
		);
		expect(
			responses.filter(
				(response) => response.status >= 200 && response.status < 300,
			),
		).toHaveLength(1);
		expect(
			responses.filter((response) => response.status === 412),
		).toHaveLength(2);
		const winner = responses.find(
			(response) => response.status >= 200 && response.status < 300,
		);
		expect(winner).toBeDefined();
		const state = await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("worker.invalid")),
			(_instance, durableState) => ({
				files: durableState.storage.sql
					.exec("SELECT path, rev, deleted, content FROM files ORDER BY path")
					.toArray(),
				revisions: durableState.storage.sql
					.exec("SELECT path, rev FROM revisions ORDER BY path, rev")
					.toArray(),
			}),
		);
		expect(state.revisions).toHaveLength(winner === rename ? 3 : 2);
		const sourceState = state.files.find(
			(file) => file.path === "notes/race-source.md",
		);
		expect(sourceState).toMatchObject({ path: "notes/race-source.md", rev: 2 });
		if (winner === write)
			expect(sourceState).toMatchObject({ content: "write", deleted: 0 });
		if (winner === deletion)
			expect(sourceState).toMatchObject({ content: null, deleted: 1 });
		if (winner === rename) {
			expect(sourceState).toMatchObject({ content: null, deleted: 1 });
			expect(state.files).toContainEqual(
				expect.objectContaining({
					path: "notes/race-destination.md",
					rev: 1,
					content: "base",
					deleted: 0,
				}),
			);
		}
		const failures = responses
			.map((response, index) => ({ response, body: bodies[index] }))
			.filter(({ response }) => response.status === 412)
			.map(({ body }) => JSON.parse(body));
		expect(failures).toHaveLength(2);
		for (const failure of failures)
			expect(failure).toMatchObject({ error: "precondition_failed" });
	});

	it("AC-11 server: retains a distinct revision when identical bytes produce the same hash", async () => {
		const first = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "identical bytes",
		});
		const firstTag = first.headers.get("ETag") ?? "";
		await first.text();
		const second = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-Match": firstTag, "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "identical bytes",
		});
		const secondTag = second.headers.get("ETag");
		await second.text();
		const rows = await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("worker.invalid")),
			(_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT rev, hash FROM revisions WHERE path = ? ORDER BY rev",
						url.split("/v1/files/")[1],
					)
					.toArray(),
		);
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(secondTag).not.toBe(firstTag);
		expect(rows).toHaveLength(2);
		expect(rows[1].hash).toBe(rows[0].hash);
	});

	it("AC-14/34 server: rejects path collisions and old-epoch mutation requests", async () => {
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
		await created.text();
		const update = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-Match": etag, "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "two",
		});
		await update.text();
		const stale = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-Match": etag, "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "stale",
		});
		expect(stale.status).toBe(412);
		await stale.text();

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

	it("AC-01 server: returns one receipt after the same key and bytes retry", async () => {
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
		await retry.text();
		expect(retry.headers.get("ETag")).toBe(first.headers.get("ETag"));
		await first.text();
		const history = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(history.status).toBe(200);
	});

	it("AC-01 server: retries through HTTP after a committed response is lost", async () => {
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
		await lost.text();
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
		await retry.text();
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
		await response.text();
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
		await settle.text();
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

	it("refuses a fifth body before it reads or reserves admission", async () => {
		const pending = Array.from({ length: 5 }, (_, index) =>
			createPendingBody(`pending-${index}`),
		);
		const requests = pending.map((body, index) =>
			SELF.fetch(`https://worker.invalid/v1/files/slot-${index}.md`, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: body.body,
				duplex: "half",
			} as RequestInit),
		);
		try {
			await Promise.all(pending.slice(0, 4).map((body) => body.ready));
			await Promise.resolve();
			expect(pending.slice(0, 4).every((body) => body.wasReadRequested())).toBe(
				true,
			);
			expect(pending[4]?.wasReadRequested()).toBe(false);
		} finally {
			for (const body of pending) body.send();
		}
		const responses = await Promise.all(requests);
		expect(responses.map((response) => response.status).sort()).toEqual(
			[201, 201, 201, 201, 429].sort(),
		);
		for (const response of responses) await response.text();
	});

	it.each([32, 1_000_000])(
		"characterizes four ordinary HTTP inline operations with %i source bytes each",
		async (size) => {
			const bodies = Array.from({ length: 4 }, (_, index) =>
				createPendingBody(String(index).repeat(size)),
			);
			const requests = bodies.map((pending, index) =>
				SELF.fetch(`https://worker.invalid/v1/files/retention-${index}.md`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: pending.body,
				}),
			);
			try {
				await Promise.all(bodies.map((pending) => pending.ready));
				expect(bodies.every((pending) => pending.wasReadRequested())).toBe(
					true,
				);
			} finally {
				for (const pending of bodies) pending.send();
			}
			const responses = await Promise.all(requests);
			for (const response of responses) {
				expect(response.status).toBe(201);
				await response.text();
			}
			for (let index = 0; index < 4; index++) {
				const read = await SELF.fetch(
					`https://worker.invalid/v1/files/retention-${index}.md`,
				);
				const body = TextReadResponseSchema.parse(await read.json());
				if (body.content === null) throw new Error("Expected inline text");
				expect(body.content.length).toBe(size);
				expect(new TextEncoder().encode(body.content).byteLength).toBe(size);
				expect(body.content[0]).toBe(String(index));
				expect(body.content[size - 1]).toBe(String(index));
			}
			console.info(
				"HTTP_INLINE_RETENTION",
				JSON.stringify({
					operations: 4,
					sourceBytes: size,
					contentUnits: size,
				}),
			);
		},
	);

	it("AC-27 server: returns write-only stale metadata without current content", async () => {
		const content = `\ufeff"\\\u0000café😀${"z".repeat(8191)}😀`;
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: content,
		});
		const metadata = MutationSuccessSchema.parse(await created.json());
		for (const identity of ["read-write", "write"]) {
			const failure = await SELF.fetch(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Test-Identity": identity,
				},
				body: "replacement",
			});
			expect(failure.status).toBe(412);
			expect(failure.headers.get("Content-Type")).toBe("application/json");
			expect(failure.headers.has("Retry-After")).toBe(false);
			const body = await failure.json();
			const canonical = encodeFileFailure({
				kind: "precondition_failed",
				etag: metadata.etag,
				hash: metadata.hash,
				deleted: false,
				...(identity === "write" ? {} : { content }),
			});
			expect(body).toEqual(canonical.body);
		}
	});

	it("characterizes slow escaped failure responses and cancellation without caller gates", async () => {
		const expectedSizes: number[] = [];
		const expectedDigests: ArrayBuffer[] = [];
		for (let index = 0; index < 4; index++) {
			const created = await SELF.fetch(
				`https://worker.invalid/v1/files/escaped-${index}.canvas`,
				{
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: "\0".repeat(999_999) + String(index),
				},
			);
			expect(created.status).toBe(201);
			const metadata = MutationSuccessSchema.parse(await created.json());
			const empty = encodeFileFailure({
				kind: "precondition_failed",
				etag: metadata.etag,
				hash: metadata.hash,
				deleted: false,
				content: "",
			});
			const emptyBody = JSON.stringify(empty.body);
			expectedSizes.push(
				new TextEncoder().encode(emptyBody).byteLength + 999_999 * 6 + 1,
			);
			expectedDigests.push(await escapedFailureDigest(emptyBody, index));
		}
		/** Start four real HTTP mutations without a result wait or an actor gate. */
		const failFour = () =>
			Promise.all(
				Array.from({ length: 4 }, (_, index) =>
					SELF.fetch(
						`https://worker.invalid/v1/files/escaped-${index}.canvas`,
						{
							method: "PUT",
							headers: {
								"If-None-Match": "*",
								"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
							},
							body: String(index + 4).repeat(1_000_000),
						},
					),
				),
			);
		const first = await failFour();
		const second: Response[] = [];
		const retry: Response[] = [];
		try {
			for (const response of first) {
				expect(response.status).toBe(412);
				expect(response.bodyUsed).toBe(false);
			}
			// The test consumer reads no first-wave body before the second HTTP wave completes.
			second.push(...(await failFour()));
			// Native transport can consume a producer before the client reads its body.
			// This schedule observes refusal now, not a general rule about unread remote bodies.
			for (const response of second) {
				expect(response.status).toBe(429);
				expect(response.headers.get("Retry-After")).toBe("1");
				expect(await response.json()).toMatchObject({
					error: "admission_limited",
				});
			}
			const unreadFirstWaveAtSecondCompletion = first.filter(
				(response) => !response.bodyUsed,
			).length;
			expect(unreadFirstWaveAtSecondCompletion).toBe(4);
			const completedBytes: number[] = [];
			for (let index = 0; index < first.length; index++) {
				const response = first[index];
				if (!response?.body) throw new Error("Expected a failure body");
				const reader = response.body.getReader({ mode: "byob" });
				let total = 0;
				const digest = new (
					crypto as Crypto & { DigestStream: typeof DigestStream }
				).DigestStream("SHA-256");
				const writer = digest.getWriter();
				try {
					for (;;) {
						const item = await reader.read(new Uint8Array(65_536));
						if (item.done) break;
						total += item.value.byteLength;
						await writer.write(item.value);
						expect(item.value.byteLength).toBeLessThanOrEqual(65_536);
					}
				} finally {
					reader.releaseLock();
				}
				await writer.close();
				expect(new Uint8Array(await digest.digest)).toEqual(
					new Uint8Array(expectedDigests[index] ?? new ArrayBuffer(0)),
				);
				expect(total).toBe(expectedSizes[index]);
				completedBytes.push(total);
			}
			// After complete production, repeat the failures and retain bounded client cancellation coverage.
			retry.push(...(await failFour()));
			for (const response of retry) {
				expect(response.status).toBe(412);
				if (!response.body)
					throw new Error("Expected a cancellable failure body");
				const reader = response.body.getReader({ mode: "byob" });
				try {
					const prefix = await reader.read(new Uint8Array(65_536));
					expect(prefix.done).toBe(false);
					expect(prefix.value?.byteLength).toBeGreaterThan(0);
					await reader.cancel("Slow HTTP consumer stopped");
				} finally {
					reader.releaseLock();
				}
			}
			const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
			const rows = await runInDurableObject(stub, async (_instance, state) => ({
				admissions: state.storage.sql
					.exec("SELECT count(*) AS n FROM operation_admissions")
					.toArray()[0]?.n,
				files: state.storage.sql
					.exec("SELECT rev, size FROM files ORDER BY path")
					.toArray(),
			}));
			expect(rows.admissions).toBe(0);
			expect(rows.files).toHaveLength(4);
			expect(
				rows.files.every((row) => row.rev === 1 && row.size === 1_000_000),
			).toBe(true);
			console.info(
				"HTTP_FAILURE_RETENTION",
				JSON.stringify({
					firstWave: first.length,
					unreadFirstWaveAtSecondCompletion,
					secondWaveStatuses: second.map((response) => response.status),
					retryWave: retry.length,
					sourceBytes: 1_000_000,
					proposedBytes: 1_000_000,
					contentUnits: 1_000_000,
					completedBytes,
					cancelledResponses: retry.length,
					admissions: rows.admissions,
				}),
			);
		} finally {
			for (const response of [...first, ...second, ...retry]) {
				if (response.body && !response.body.locked)
					await response.body.cancel();
			}
		}
	}, 15_000);

	it("rejects malformed mutation epochs and marks historical reads without an epoch pruned", async () => {
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
		expect(historical.status).toBe(410);
		expect(await historical.json()).toMatchObject({ error: "revision_pruned" });
		const malformedHistoricalEpoch = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": "invalid" },
		});
		expect(malformedHistoricalEpoch.status).toBe(400);
		const obsoleteHistoricalEpoch = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": "fedcba9876543210fedcba9876543210" },
		});
		expect(obsoleteHistoricalEpoch.status).toBe(409);
		expect(await obsoleteHistoricalEpoch.json()).toMatchObject({
			error: "epoch_mismatch",
			current_epoch: TEXT_FIXTURE_EPOCH,
		});
	});
});
