import { env, runInDurableObject, SELF } from "cloudflare:test";
import { FileOperationDenied } from "@worker/application/files";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import {
	captureTextStoreState,
	TEXT_FIXTURE_EPOCH,
} from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { beforeEach, describe, expect, it } from "vitest";

/** Hash exact test bytes independently of the upload adapter. */
async function digest(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Native HTTP publication and raw read contracts use actual local R2. */
describe("declared blob HTTP", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("blob.invalid"));
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
	it.each([0, 1_000_000, 1_000_001, 1_500_000, 25_000_000])(
		"publishes and streams %i exact binary bytes",
		async (size) => {
			const bytes = new Uint8Array(size).fill(255);
			if (size) bytes[0] = 0;
			const hash = await digest(bytes);
			const url = `https://blob.invalid/v1/files/boundary-${size}.bin`;
			const put = await SELF.fetch(url, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": hash,
					"X-Content-Size": String(size),
				},
				body: bytes,
			});
			await put.text();
			expect(put.status).toBe(201);
			const get = await SELF.fetch(url);
			expect(get.status).toBe(200);
			expect(get.headers.get("ETag")).toBe(put.headers.get("ETag"));
			expect(get.headers.get("Content-Length")).toBe(String(size));
			expect(get.headers.get("Accept-Ranges")).toBe("bytes");
			expect(get.headers.get("X-File-Large")).toBe("false");
			const downloaded = new Uint8Array(await get.arrayBuffer());
			expect(downloaded.byteLength).toBe(size);
			expect(await digest(downloaded)).toBe(hash);
			if (size < 100) expect(downloaded).toEqual(bytes);
		},
	);
	it("verifies declarations on inline bytes", async () => {
		const response = await SELF.fetch(
			"https://blob.invalid/v1/files/forged.md",
			{
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": "0".repeat(64),
					"X-Content-Size": "4",
				},
				body: "text",
			},
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: "blob_integrity_mismatch",
		});
	});
	it("rejects missing binary declarations without body demand", async () => {
		const request = new Request("https://blob.invalid/v1/files/missing.bin", {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "bytes",
		});
		expect((await testWorker.fetch(request, env)).status).toBe(400);
		expect(request.bodyUsed).toBe(false);
	});
	it.each([
		[{ "X-Content-Size": "1" }, 400, "invalid_request"],
		[{ "X-Content-SHA256": "0".repeat(64) }, 400, "invalid_request"],
		[
			{ "X-Content-SHA256": "A".repeat(64), "X-Content-Size": "1" },
			400,
			"invalid_request",
		],
		[
			{ "X-Content-SHA256": "0".repeat(64), "X-Content-Size": "01" },
			400,
			"invalid_request",
		],
		[
			{ "X-Content-SHA256": "0".repeat(64), "X-Content-Size": "25000001" },
			413,
			"blob_too_large",
		],
		[
			{
				"X-Content-SHA256": "0".repeat(64),
				"X-Content-Size": "1",
				"Content-Length": "2",
			},
			400,
			"invalid_request",
		],
	] as const)(
		"rejects declaration headers %j",
		async (extra, status, error) => {
			const request = new Request("https://blob.invalid/v1/files/headers.bin", {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					...extra,
				},
				body: "a",
			});
			const response = await testWorker.fetch(request, env);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ error });
			expect(request.bodyUsed).toBe(false);
		},
	);
	it("AC-16 server: preserves large Markdown bytes and exact range reads", async () => {
		const bytes = new Uint8Array(1_500_000).fill(97);
		bytes.set([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
		const hash = await digest(bytes);
		const url = "https://blob.invalid/v1/files/large.md";
		const put = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": hash,
				"X-Content-Size": String(bytes.byteLength),
			},
			body: bytes,
		});
		await put.text();
		expect(put.status).toBe(201);
		for (const [range, status, selected] of [
			["bytes=0-4", 206, "bytes 0-4/1500000"],
			["bytes=1499999-1499999", 206, "bytes 1499999-1499999/1500000"],
			["bytes=0-999999", 206, "bytes 0-999999/1500000"],
			["bytes=0-", 206, "bytes 0-999999/1500000"],
			["bytes=0-1000000", 416, "bytes */1500000"],
			["bytes=1500000-", 416, "bytes */1500000"],
			["bytes=0-1,3-4", 416, "bytes */1500000"],
			["bytes=-1", 416, "bytes */1500000"],
		] as const) {
			const get = await SELF.fetch(url, { headers: { Range: range } });
			expect(get.status).toBe(status);
			expect(get.headers.get("Content-Range")).toBe(selected);
			expect(get.headers.get("ETag")).toBe(put.headers.get("ETag"));
			if (status === 206) {
				expect(get.headers.get("X-File-Large")).toBe("true");
				const received = new Uint8Array(await get.arrayBuffer());
				if (range === "bytes=0-4")
					expect(received).toEqual(bytes.subarray(0, 5));
				else if (range === "bytes=0-999999" || range === "bytes=0-")
					expect(await digest(received)).toBe(
						await digest(bytes.subarray(0, 1_000_000)),
					);
				else expect(received).toEqual(new Uint8Array([97]));
			}
		}
		const update = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": put.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "inline",
		});
		await update.text();
		expect(update.status).toBe(200);
		const retained = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH, Range: "bytes=0-4" },
		});
		expect(retained.status).toBe(206);
		expect(new Uint8Array(await retained.arrayBuffer())).toEqual(
			bytes.subarray(0, 5),
		);
		const missingEpoch = await SELF.fetch(`${url}?rev=1`, {
			headers: { Range: "bytes=0-4" },
		});
		expect(missingEpoch.status).toBe(410);
		expect(await missingEpoch.json()).toMatchObject({
			error: "revision_pruned",
		});
		const current = await SELF.fetch(url);
		expect(await current.json()).toMatchObject({
			content: "inline",
			kind: "text",
		});
	});
	it("rejects forged bytes and measured length mismatches without changing an existing object", async () => {
		const bytes = new Uint8Array([0, 255, 128, 1]);
		const hash = await digest(bytes);
		await env.R2_BUCKET.put(`blobs/${hash}`, bytes, { sha256: hash });
		for (const body of [
			new Uint8Array([9, 9, 9, 9]),
			bytes.subarray(0, 3),
			new Uint8Array(5),
		]) {
			const response = await testWorker.fetch(
				new Request("https://blob.invalid/v1/files/forged.bin", {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"X-Content-SHA256": hash,
						"X-Content-Size": "4",
					},
					body: new Blob([body]).stream(),
				}),
				env,
			);
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				error: "blob_integrity_mismatch",
			});
			const stored = await env.R2_BUCKET.get(`blobs/${hash}`);
			if (!stored) throw new Error("Expected immutable object");
			expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
		}
	});
	it("rejects a pre-revoked 20 MB request before body demand", async () => {
		const request = new Request("https://blob.invalid/v1/files/revoked.bin", {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Test-Identity": "revoked",
				"X-Content-SHA256": "0".repeat(64),
				"X-Content-Size": "20000000",
			},
			body: new Uint8Array(20_000_000),
		});
		const before = await env.R2_BUCKET.list();
		const response = await testWorker.fetch(request, env);
		await response.text();
		expect(response.status).toBe(401);
		expect(request.bodyUsed).toBe(false);
		expect(await env.R2_BUCKET.list()).toEqual(before);
	});
	it.each(["\ufeffé", "🦉", "", "a".repeat(1_000_000)])(
		"keeps exact declared inline UTF-8",
		async (content) => {
			const bytes = new TextEncoder().encode(content);
			const response = await SELF.fetch(
				"https://blob.invalid/v1/files/exact.md",
				{
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"X-Content-SHA256": await digest(bytes),
						"X-Content-Size": String(bytes.byteLength),
					},
					body: bytes,
				},
			);
			await response.text();
			expect(response.status).toBe(201);
			const get = await SELF.fetch("https://blob.invalid/v1/files/exact.md");
			expect(await get.json()).toMatchObject({
				content,
				size: bytes.byteLength,
			});
		},
	);
	it("rejects an unpaired oversized declaration as malformed", async () => {
		const request = new Request("https://blob.invalid/v1/files/invalid.bin", {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-Size": "25000001",
			},
			body: "x",
		});
		const response = await testWorker.fetch(request, env);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_request" });
		expect(request.bodyUsed).toBe(false);
	});
	it("reports an inline declared length mismatch at the inline ceiling", async () => {
		const input = new Uint8Array(1_000_001).fill(97);
		const response = await testWorker.fetch(
			new Request("https://blob.invalid/v1/files/inline-mismatch.md", {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": "0".repeat(64),
					"X-Content-Size": "1000000",
				},
				body: new Blob([input]).stream(),
			}),
			env,
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: "blob_integrity_mismatch",
		});
	});

	it("rejects actual 25,000,001-byte input through the HTTP boundary", async () => {
		const response = await testWorker.fetch(
			new Request("https://blob.invalid/v1/files/overflow.bin", {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": await digest(new Uint8Array(25_000_000)),
					"X-Content-Size": "25000000",
				},
				body: new Blob([new Uint8Array(25_000_001)]).stream(),
			}),
			env,
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error: "blob_too_large" });
	});
	it("AC-01/16 server: replays a lost blob result with one revision and receipt", async () => {
		const bytes = new Uint8Array([255, 0, 1]);
		const headers = {
			"If-None-Match": "*",
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			"X-Content-SHA256": await digest(bytes),
			"X-Content-Size": "3",
			"Idempotency-Key": "http-lost-blob-result",
		};
		const url = "https://blob.invalid/v1/files/lost.bin";
		const lost = await SELF.fetch(url, {
			method: "PUT",
			headers: { ...headers, "X-Test-Lose-Commit-Response": "true" },
			body: bytes,
		});
		await lost.text();
		expect(lost.status).toBe(500);
		const retry = await SELF.fetch(url, {
			method: "PUT",
			headers,
			body: bytes,
		});
		await retry.text();
		expect(retry.status).toBe(201);
		const state = await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("blob.invalid")),
			async (_instance, state) => ({
				revisions: state.storage.sql.exec("SELECT * FROM revisions").toArray(),
				changes: state.storage.sql.exec("SELECT * FROM changes").toArray(),
				receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
			}),
		);
		expect(state.revisions).toHaveLength(1);
		expect(state.changes).toHaveLength(1);
		expect(state.receipts).toHaveLength(1);
		const downloaded = await SELF.fetch(url);
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
	});
	it("fails closed when authoritative blob storage is missing and checks read revocation first", async () => {
		const bytes = new Uint8Array([1, 255, 0]);
		const hash = await digest(bytes);
		const url = "https://blob.invalid/v1/files/missing-storage.bin";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": hash,
				"X-Content-Size": "3",
			},
			body: bytes,
		});
		await created.text();
		expect(created.status).toBe(201);
		const denied = await SELF.fetch(url, {
			headers: { "X-Test-Identity": "revoked" },
		});
		expect(denied.status).toBe(401);
		await env.R2_BUCKET.delete(`blobs/${hash}`);
		const missing = await SELF.fetch(url);
		expect(missing.status).toBe(503);
		expect(missing.headers.get("Retry-After")).toBe("1");
		expect(await missing.json()).toMatchObject({
			error: "blob_storage_unavailable",
		});
		const absent = await SELF.fetch(
			"https://blob.invalid/v1/files/no-reference.bin",
		);
		expect(absent.status).toBe(404);
		const pruned = await SELF.fetch(`${url}?rev=2`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(pruned.status).toBe(410);
		expect(await pruned.json()).toMatchObject({ error: "revision_pruned" });
	});
	it("streams declared large invalid-UTF-8 Markdown without decoding it", async () => {
		const bytes = new Uint8Array(1_000_001).fill(255);
		const hash = await digest(bytes);
		const url = "https://blob.invalid/v1/files/raw.md";
		const response = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": hash,
				"X-Content-Size": String(bytes.byteLength),
			},
			body: bytes,
		});
		await response.text();
		expect(response.status).toBe(201);
		const get = await SELF.fetch(url);
		expect(get.headers.get("X-File-Large")).toBe("true");
		expect(await digest(new Uint8Array(await get.arrayBuffer()))).toBe(hash);
	});
	it("AC-28 server: rejects a revoked 20 MB declaration before body demand", async () => {
		let operations = 0;
		let demand = 0;
		const native = new R2BlobStore(env.R2_BUCKET);
		const worker = createWorker(
			async () => ({
				client_id: "revoked-caller",
				grant_id: "http-revoked-grant",
				scopes: ["vault:write", "vault:read"],
			}),
			(bindings) =>
				bindings.VAULTS.get(bindings.VAULTS.idFromName("blob.invalid")),
			() => ({
				head: async (...args) => {
					operations++;
					return native.head(...args);
				},
				putVerified: async (...args) => {
					operations++;
					return native.putVerified(...args);
				},
				read: async (...args) => {
					operations++;
					return native.read(...args);
				},
			}),
		);
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Record forbidden source demand after native authority rejects the grant. */
			pull() {
				demand++;
			},
		});
		const denied = await worker.fetch(
			new Request("https://blob.invalid/v1/files/revoked.bin", {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": "0".repeat(64),
					"X-Content-Size": "20000000",
				},
				body,
			}),
			env,
		);
		expect(denied.status).toBe(401);
		expect(operations).toBe(0);
		expect(demand).toBe(0);
		const read = await worker.fetch(
			new Request("https://blob.invalid/v1/files/unknown.bin"),
			env,
		);
		expect(read.status).toBe(401);
		expect(operations).toBe(0);
	});
	it("returns the canonical storage failure and retry header for an injected throttle", async () => {
		const native = new R2BlobStore(env.R2_BUCKET);
		const worker = createWorker(
			async () => ({
				client_id: "throttled-client",
				grant_id: "throttled-grant",
				scopes: ["vault:write"],
			}),
			(bindings) =>
				bindings.VAULTS.get(bindings.VAULTS.idFromName("blob.invalid")),
			() => ({
				head: (...args) => native.head(...args),
				read: (...args) => native.read(...args),
				putVerified: async () => {
					throw new FileOperationDenied({
						kind: "blob_storage_unavailable",
						retry_after_seconds: 1,
					});
				},
			}),
		);
		const response = await worker.fetch(
			new Request("https://blob.invalid/v1/files/throttled.bin", {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": await digest(new Uint8Array([1])),
					"X-Content-Size": "1",
				},
				body: new Blob([new Uint8Array([1])]).stream(),
			}),
			env,
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		expect(await response.json()).toMatchObject({
			error: "blob_storage_unavailable",
		});
	});
	it("rejects invalid inline UTF-8 even when its raw declaration matches", async () => {
		const bytes = new Uint8Array([255]);
		const response = await SELF.fetch(
			"https://blob.invalid/v1/files/invalid.md",
			{
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": await digest(bytes),
					"X-Content-Size": "1",
				},
				body: bytes,
			},
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_request" });
	});
	it("renames, deletes, and restores binary references without changing immutable bytes", async () => {
		const bytes = new Uint8Array([0, 255, 1, 128]);
		const hash = await digest(bytes);
		const source = "https://blob.invalid/v1/files/source.bin";
		const target = "https://blob.invalid/v1/files/target.bin";
		const created = await SELF.fetch(source, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": hash,
				"X-Content-Size": "4",
			},
			body: bytes,
		});
		await created.text();
		expect(created.status).toBe(201);
		const renamed = await SELF.fetch(`${source}:rename`, {
			method: "POST",
			headers: { "If-Match": created.headers.get("ETag") ?? "" },
			body: JSON.stringify({ to: "target.bin" }),
		});
		await renamed.text();
		expect(renamed.status).toBe(201);
		const renamedBytes = await SELF.fetch(target);
		expect(new Uint8Array(await renamedBytes.arrayBuffer())).toEqual(bytes);
		const sourceOld = await SELF.fetch(`${source}?rev=1`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(new Uint8Array(await sourceOld.arrayBuffer())).toEqual(bytes);
		const deleted = await SELF.fetch(target, {
			method: "DELETE",
			headers: { "If-Match": renamed.headers.get("ETag") ?? "" },
		});
		expect(deleted.status).toBe(200);
		const tombstone = await SELF.fetch(target);
		expect(tombstone.status).toBe(409);
		expect(await tombstone.json()).toMatchObject({ error: "tombstone" });
		const restored = await SELF.fetch(`${target}:restore`, {
			method: "POST",
			headers: { "If-Match": deleted.headers.get("ETag") ?? "" },
			body: JSON.stringify({ source_rev: 1 }),
		});
		await restored.text();
		expect(restored.status).toBe(201);
		const restoredBytes = await SELF.fetch(target);
		expect(new Uint8Array(await restoredBytes.arrayBuffer())).toEqual(bytes);
		const object = await env.R2_BUCKET.get(`blobs/${hash}`);
		if (!object) throw new Error("Expected immutable object");
		expect(new Uint8Array(await object.arrayBuffer())).toEqual(bytes);
	});
	it("changes inline text to a blob while preserving inline history and removing native FTS", async () => {
		const url = "https://blob.invalid/v1/files/transition.md";
		const first = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "old inline",
		});
		await first.text();
		const bytes = new Uint8Array(1_500_000).fill(97);
		const updated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": first.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": await digest(bytes),
				"X-Content-Size": String(bytes.byteLength),
			},
			body: bytes,
		});
		await updated.text();
		expect(updated.status).toBe(200);
		const retained = await SELF.fetch(`${url}?rev=1`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(await retained.json()).toMatchObject({
			kind: "text",
			content: "old inline",
		});
		const selected = await SELF.fetch(url, { headers: { Range: "bytes=0-0" } });
		expect(selected.status).toBe(206);
		expect(selected.headers.get("X-File-Large")).toBe("true");
		expect(new Uint8Array(await selected.arrayBuffer())).toEqual(
			new Uint8Array([97]),
		);
		const native = await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("blob.invalid")),
			async (_instance, state) => ({
				files: state.storage.sql
					.exec(
						"SELECT kind,size,content FROM files WHERE path = 'transition.md'",
					)
					.toArray(),
				search: state.storage.sql
					.exec("SELECT path FROM files_fts WHERE path = 'transition.md'")
					.toArray(),
				references: state.storage.sql
					.exec("SELECT size FROM blob_refs")
					.toArray(),
			}),
		);
		expect(native.files).toEqual([
			{ kind: "blob", size: 1_500_000, content: null },
		]);
		expect(native.search).toHaveLength(0);
		expect(native.references).toEqual([{ size: 1_500_000 }]);
	});
	it("keeps standard JSON duplicate keys and escaped strings in bounded command decoding", async () => {
		const url = "https://blob.invalid/v1/files/json-source.md";
		const first = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "source",
		});
		await first.text();
		const malformed = [
			'{"to":{"nested":[]}}',
			'{"to":"target.md","extra":1,"third":2}',
			'[{"to":"target.md"}]',
		];
		for (const body of malformed) {
			const rejected = await SELF.fetch(`${url}:rename`, {
				method: "POST",
				headers: { "If-Match": first.headers.get("ETag") ?? "" },
				body,
			});
			await rejected.text();
			expect(rejected.status).toBe(400);
		}
		const target = 'literal{"}.md';
		const body = `{"to":"discarded.md",${JSON.stringify({ to: target }).slice(1)}`;
		const renamed = await SELF.fetch(`${url}:rename`, {
			method: "POST",
			headers: { "If-Match": first.headers.get("ETag") ?? "" },
			body,
		});
		expect(renamed.status).toBe(201);
		expect(await renamed.json()).toMatchObject({ path: target });
	});
	it("uses declared length for an unknown-length native request stream", async () => {
		const bytes = new Uint8Array([255, 128, 0, 1]);
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Supply exact binary data without a transport length hint. */
			pull(controller) {
				controller.enqueue(bytes.slice());
				controller.close();
			},
		});
		const url = "https://blob.invalid/v1/files/unknown-length.bin";
		const request = new Request(url, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				"X-Content-SHA256": await digest(bytes),
				"X-Content-Size": "4",
			},
			body,
		});
		expect(request.headers.has("Content-Length")).toBe(false);
		const put = await testWorker.fetch(request, env);
		await put.text();
		expect(put.status).toBe(201);
		const get = await SELF.fetch(url);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
	});
	it.each(["live", "missing", "deleted", "large"] as const)(
		"rejects append from authoritative %s blob state without mutation",
		async (state) => {
			const bytes =
				state === "large"
					? new Uint8Array(1_500_000).fill(97)
					: new Uint8Array([0, 255, 1, 128]);
			const hash = await digest(bytes);
			const url = `https://blob.invalid/v1/files/append-state.${state === "large" ? "md" : "bin"}`;
			if (state !== "missing") {
				const created = await SELF.fetch(url, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"X-Content-SHA256": hash,
						"X-Content-Size": String(bytes.byteLength),
					},
					body: bytes,
				});
				await created.text();
				expect(created.status).toBe(201);
				if (state === "deleted")
					expect(
						(
							await SELF.fetch(url, {
								method: "DELETE",
								headers: { "If-Match": created.headers.get("ETag") ?? "" },
							})
						).status,
					).toBe(200);
			}
			const stub = env.VAULTS.get(env.VAULTS.idFromName("blob.invalid"));
			const before = await runInDurableObject(
				stub,
				async (_instance, objectState) =>
					captureTextStoreState(objectState.storage),
			);
			const object = await env.R2_BUCKET.get(`blobs/${hash}`);
			const beforeHash =
				object === null
					? null
					: await digest(new Uint8Array(await object.arrayBuffer()));
			const append = await SELF.fetch(`${url}:append`, {
				method: "POST",
				headers: {
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "binary-append-http-key",
				},
				body: "x",
			});
			expect(append.status).toBe(
				state === "missing" ? 404 : state === "deleted" ? 409 : 415,
			);
			expect(await append.json()).toMatchObject({
				error:
					state === "missing"
						? "not_found"
						: state === "deleted"
							? "tombstone"
							: "unsupported_append_kind",
			});
			const after = await runInDurableObject(
				stub,
				async (_instance, objectState) =>
					captureTextStoreState(objectState.storage),
			);
			expect(after).toEqual(before);
			const preserved = await env.R2_BUCKET.get(`blobs/${hash}`);
			expect(
				preserved === null
					? null
					: await digest(new Uint8Array(await preserved.arrayBuffer())),
			).toBe(beforeHash);
		},
	);
	it("checks binary append policy before it discloses state or reads a body", async () => {
		for (const [extra, status] of [
			[{ "X-Test-Identity": "read" }, 403],
			[{ "X-Test-Identity": "revoked" }, 401],
			[{ "X-Vault-Epoch": "a".repeat(32) }, 409],
			[{ "Idempotency-Key": "" }, 400],
		] as const) {
			const request = new Request(
				"https://blob.invalid/v1/files/private.bin:append",
				{
					method: "POST",
					headers: {
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"Idempotency-Key": "binary-policy-key",
						...extra,
					},
					body: "x",
				},
			);
			expect((await testWorker.fetch(request, env)).status).toBe(status);
			expect(request.bodyUsed).toBe(false);
		}
		const request = new Request(
			"https://blob.invalid/v1/files/private.bin:append",
			{
				method: "POST",
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "x",
			},
		);
		expect((await testWorker.fetch(request, env)).status).toBe(428);
		expect(request.bodyUsed).toBe(false);
	});
});
