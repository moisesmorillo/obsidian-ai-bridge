import { env, runInDurableObject, SELF } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** A zero-buffer request body that exposes read demand and waits for explicit release. */
function pendingBody(value: string) {
	let release: (() => void) | undefined;
	let markDemand: (() => void) | undefined;
	const demanded = new Promise<void>((resolve) => {
		markDemand = resolve;
	});
	const body = new ReadableStream<Uint8Array>(
		{
			/** Signal body demand and wait for explicit test release. */
			pull(controller) {
				markDemand?.();
				return new Promise<void>((resolve) => {
					release = () => {
						controller.enqueue(new TextEncoder().encode(value));
						controller.close();
						resolve();
					};
				});
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, demanded, release: () => release?.() };
}

/** Exercise history command routes through the Worker and its real Durable Object. */
describe("history mutation HTTP routes", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
		});
	});

	it("renames through HTTP and reads the immutable destination revision", async () => {
		const base = "https://worker.invalid/v1/files/notes/source.md";
		const created = await SELF.fetch(base, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "original",
		});
		const sourceTag = created.headers.get("ETag");
		const renamed = await SELF.fetch(`${base}:rename`, {
			method: "POST",
			headers: {
				"If-Match": sourceTag ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: JSON.stringify({ to: "notes/destination.md" }),
		});
		expect(renamed.status).toBe(201);
		expect(renamed.headers.get("ETag")).toBe(
			'"0123456789abcdef0123456789abcdef.1"',
		);
		const nativeRename = await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("worker.invalid")),
			async (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT path, from_path, from_rev, rev FROM changes WHERE op = ?",
						"rename",
					)
					.toArray(),
		);
		expect(nativeRename).toHaveLength(1);
		expect(nativeRename[0]).toMatchObject({
			path: "notes/destination.md",
			from_path: "notes/source.md",
			from_rev: 2,
			rev: 1,
		});
		const later = await SELF.fetch(
			"https://worker.invalid/v1/files/notes/destination.md",
			{
				method: "PUT",
				headers: {
					"If-Match": renamed.headers.get("ETag") ?? "",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "later",
			},
		);
		expect(later.status).toBe(200);
		const history = await SELF.fetch(
			"https://worker.invalid/v1/history/notes/destination.md",
		);
		expect(history.status).toBe(200);
		expect(await history.json()).toMatchObject([
			{ rev: 1, size: 8, deleted: false },
			{ rev: 2, size: 5, deleted: false },
		]);
		const pinned = await SELF.fetch(
			"https://worker.invalid/v1/files/notes/destination.md?rev=1",
			{
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			},
		);
		expect(await pinned.json()).toMatchObject({ content: "original" });
	});

	it("appends exact UTF-8 bytes and restores against the observed tombstone ETag", async () => {
		const url = "https://worker.invalid/v1/files/notes/append.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "start",
		});
		expect(created.status).toBe(201);
		const appended = await SELF.fetch(`${url}:append`, {
			method: "POST",
			headers: {
				"Idempotency-Key": "http-append-key-0001",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "\uFEFF\u0000尾",
		});
		expect(appended.status).toBe(200);
		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": appended.headers.get("ETag") ?? "" },
		});
		const tombstoneAppend = await SELF.fetch(`${url}:append`, {
			method: "POST",
			headers: {
				"Idempotency-Key": "append-tombstone-001",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "blocked",
		});
		expect(tombstoneAppend.status).toBe(409);
		const restored = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: { "If-Match": deleted.headers.get("ETag") ?? "" },
			body: JSON.stringify({ source_rev: 2 }),
		});
		expect(restored.status).toBe(201);
		const content = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(((await content.json()) as { content: string }).content).toBe(
			"start\uFEFF\u0000尾",
		);
		const missingKey = await SELF.fetch(`${url}:append`, {
			method: "POST",
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "x",
		});
		expect(missingKey.status).toBe(428);
	});

	it("reserves rename capacity before a delayed body and rechecks source revision", async () => {
		const url = "https://worker.invalid/v1/files/source.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "source",
		});
		const body = pendingBody(JSON.stringify({ to: "destination.md" }));
		const renamePromise = SELF.fetch(`${url}:rename`, {
			method: "POST",
			headers: {
				"If-Match": created.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: body.body,
		});
		await body.demanded;
		const observed = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(((await observed.json()) as { content: string }).content).toBe(
			"source",
		);
		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": created.headers.get("ETag") ?? "" },
		});
		expect(deleted.status).toBe(200);
		body.release();
		const response = await renamePromise;
		expect(response.status).toBe(412);
	});

	it("authorizes history reads by scope and keeps history content-free", async () => {
		const created = await SELF.fetch(
			"https://worker.invalid/v1/files/private.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "private bytes",
			},
		);
		const denied = await SELF.fetch(
			"https://worker.invalid/v1/history/private.md",
			{ headers: { "X-Test-Identity": "write" } },
		);
		expect(denied.status).toBe(403);
		const allowed = await SELF.fetch(
			"https://worker.invalid/v1/history/private.md",
		);
		expect(allowed.status).toBe(200);
		const entries = await allowed.json();
		expect(entries).toMatchObject([{ rev: 1, size: 13, deleted: false }]);
		expect(JSON.stringify(entries)).not.toContain("private bytes");
		const writeDenied = await SELF.fetch(
			"https://worker.invalid/v1/files/private.md",
			{
				method: "PUT",
				headers: {
					"X-Test-Identity": "read",
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "denied",
			},
		);
		const deleteDenied = await SELF.fetch(
			"https://worker.invalid/v1/files/private.md",
			{
				method: "DELETE",
				headers: {
					"X-Test-Identity": "read",
					"If-Match": created.headers.get("ETag") ?? "",
				},
			},
		);
		expect(writeDenied.status).toBe(403);
		expect(deleteDenied.status).toBe(403);
		expect(created.status).toBe(201);
	});

	it("requires write scope and redacts current content from write-only failures", async () => {
		const url = "https://worker.invalid/v1/files/private-restore.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "secret current content",
		});
		const updated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": created.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "new current content",
		});
		const denied = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: {
				"X-Test-Identity": "read",
				"If-Match": updated.headers.get("ETag") ?? "",
			},
			body: JSON.stringify({ source_rev: 1 }),
		});
		expect(denied.status).toBe(403);
		const stale = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: {
				"X-Test-Identity": "write",
				"If-Match": created.headers.get("ETag") ?? "",
			},
			body: JSON.stringify({ source_rev: 1 }),
		});
		expect(stale.status).toBe(412);
		const failure = (await stale.json()) as Record<string, unknown>;
		expect(failure).not.toHaveProperty("content");
		expect(JSON.stringify(failure)).not.toContain("new current content");
	});

	it("returns one rename feed entry for collision, case-only rename, and tombstone destination", async () => {
		/** Create one text file through the real conditional HTTP route. */
		const put = async (path: string, content: string) =>
			SELF.fetch(`https://worker.invalid/v1/files/${path}`, {
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: content,
			});
		const source = await put("source.md", "source");
		const destination = await put("destination.md", "old destination");
		const collision = await SELF.fetch(
			"https://worker.invalid/v1/files/source.md:rename",
			{
				method: "POST",
				headers: { "If-Match": source.headers.get("ETag") ?? "" },
				body: JSON.stringify({ to: "destination.md" }),
			},
		);
		expect(collision.status).toBe(409);
		expect(await collision.json()).toMatchObject({
			error: "path_collision",
			existing_path: "destination.md",
		});
		const caseOnly = await SELF.fetch(
			"https://worker.invalid/v1/files/source.md:rename",
			{
				method: "POST",
				headers: { "If-Match": source.headers.get("ETag") ?? "" },
				body: JSON.stringify({ to: "Source.md" }),
			},
		);
		expect(caseOnly.status).toBe(201);
		const deletedDestination = await SELF.fetch(
			"https://worker.invalid/v1/files/destination.md",
			{
				method: "DELETE",
				headers: { "If-Match": destination.headers.get("ETag") ?? "" },
			},
		);
		const currentSource = await SELF.fetch(
			"https://worker.invalid/v1/files/Source.md",
			{ headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH } },
		);
		const sourceTag = currentSource.headers.get("ETag");
		const intoTombstone = await SELF.fetch(
			"https://worker.invalid/v1/files/Source.md:rename",
			{
				method: "POST",
				headers: { "If-Match": sourceTag ?? "" },
				body: JSON.stringify({ to: "destination.md" }),
			},
		);
		expect(intoTombstone.status).toBe(201);
		expect(intoTombstone.headers.get("ETag")).toBe(
			'"0123456789abcdef0123456789abcdef.3"',
		);
		expect(deletedDestination.status).toBe(200);
	});

	it("replays a committed append after a lost HTTP response without appending twice", async () => {
		const url = "https://worker.invalid/v1/files/replay.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "base",
		});
		const headers = {
			"Idempotency-Key": "http-append-replay-01",
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			"X-Test-Lose-Commit-Response": "true",
		};
		const lost = await SELF.fetch(`${url}:append`, {
			method: "POST",
			headers,
			body: "+tail",
		});
		expect(lost.status).toBe(500);
		const replay = await SELF.fetch(`${url}:append`, {
			method: "POST",
			headers: { ...headers, "X-Test-Lose-Commit-Response": "false" },
			body: "+tail",
		});
		expect(replay.status).toBe(200);
		expect(replay.headers.get("ETag")).toBe(
			'"0123456789abcdef0123456789abcdef.2"',
		);
		const current = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(((await current.json()) as { content: string }).content).toBe(
			"base+tail",
		);
		expect(created.status).toBe(201);
	});

	it("reports canonical append precondition and size failures", async () => {
		const conflictingCondition = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "append-conflict-cond-01",
				},
				body: "x",
			},
		);
		expect(conflictingCondition.status).toBe(400);
		const missingEpoch = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: { "Idempotency-Key": "append-no-epoch-001" },
				body: "x",
			},
		);
		expect(missingEpoch.status).toBe(409);
		expect(await missingEpoch.json()).toMatchObject({
			error: "epoch_mismatch",
		});
		const missingKey = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "x",
			},
		);
		expect(missingKey.status).toBe(428);
		const absent = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: {
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "append-not-found-001",
				},
				body: "x",
			},
		);
		expect(absent.status).toBe(404);
		const staleEpoch = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: {
					"X-Vault-Epoch": "11111111111111111111111111111111",
					"Idempotency-Key": "append-stale-epoch-01",
				},
				body: "x",
			},
		);
		expect(staleEpoch.status).toBe(409);
		const oversized = await SELF.fetch(
			"https://worker.invalid/v1/files/missing.md:append",
			{
				method: "POST",
				headers: {
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "append-too-large-001",
				},
				body: "x".repeat(1_000_001),
			},
		);
		expect(oversized.status).toBe(413);
		const blobPath = "blob.md";
		const blob = await SELF.fetch(
			`https://worker.invalid/v1/files/${blobPath}`,
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "inline before blob promotion",
			},
		);
		await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("worker.invalid")),
			async (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE files SET kind = 'blob', content = NULL, blob_hash = ?, hash = ? WHERE path = ?",
					"b".repeat(64),
					"b".repeat(64),
					blobPath,
				);
			},
		);
		const unsupported = await SELF.fetch(
			`https://worker.invalid/v1/files/${blobPath}:append`,
			{
				method: "POST",
				headers: {
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "append-blob-kind-01",
				},
				body: "x",
			},
		);
		expect(blob.status).toBe(201);
		expect(unsupported.status).toBe(415);
	});

	it("requires restore consent, rejects a stale retry, and reports pruned history", async () => {
		const url = "https://worker.invalid/v1/files/restore.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "retained",
		});
		const updated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": created.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "current",
		});
		const occupied = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: { "If-Match": updated.headers.get("ETag") ?? "" },
			body: JSON.stringify({ source_rev: 1 }),
		});
		expect(occupied.status).toBe(409);
		expect(await occupied.json()).toMatchObject({ error: "path_occupied" });
		const restoreHeaders = {
			"If-Match": updated.headers.get("ETag") ?? "",
			"X-Test-Lose-Commit-Response": "true",
		};
		const lost = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: restoreHeaders,
			body: JSON.stringify({ source_rev: 1, as_conflict_copy: true }),
		});
		expect(lost.status).toBe(500);
		const afterRestore = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": afterRestore.headers.get("ETag") ?? "" },
		});
		const staleRetry = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: { "If-Match": updated.headers.get("ETag") ?? "" },
			body: JSON.stringify({ source_rev: 1, as_conflict_copy: true }),
		});
		expect(deleted.status).toBe(200);
		expect(staleRetry.status).toBe(412);
		await runInDurableObject(
			env.VAULTS.get(env.VAULTS.idFromName("worker.invalid")),
			async (_instance, state) => {
				state.storage.sql.exec(
					"DELETE FROM revisions WHERE path = ? AND rev = ?",
					"restore.md",
					1,
				);
			},
		);
		const current = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		const pruned = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: { "If-Match": current.headers.get("ETag") ?? "" },
			body: JSON.stringify({ source_rev: 1, as_conflict_copy: true }),
		});
		expect(pruned.status).toBe(410);
	});

	it("replays a keyed restore receipt without resurrecting a later deletion", async () => {
		const url = "https://worker.invalid/v1/files/keyed-restore.md";
		const created = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "retained",
		});
		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": created.headers.get("ETag") ?? "" },
		});
		const restoreHeaders = {
			"If-Match": deleted.headers.get("ETag") ?? "",
			"Idempotency-Key": "restore-http-replay-001",
		};
		const first = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: restoreHeaders,
			body: JSON.stringify({ source_rev: 1 }),
		});
		expect(first.status).toBe(201);
		const secondDelete = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": first.headers.get("ETag") ?? "" },
		});
		const replay = await SELF.fetch(`${url}:restore`, {
			method: "POST",
			headers: restoreHeaders,
			body: JSON.stringify({ source_rev: 1 }),
		});
		expect(secondDelete.status).toBe(200);
		expect(replay.status).toBe(201);
		expect(replay.headers.get("ETag")).toBe(first.headers.get("ETag"));
		const current = await SELF.fetch(url, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(await current.json()).toMatchObject({
			deleted: true,
			etag: secondDelete.headers.get("ETag"),
		});
	});

	it("routes only literal raw command suffixes and decodes file paths once", async () => {
		for (const item of [
			{ encoded: "notes/literal%3Arename.md", path: "notes/literal:rename.md" },
			{ encoded: "notes/100%25.md", path: "notes/100%.md" },
			{ encoded: "notes/caf%C3%A9%20x.md", path: "notes/café x.md" },
		]) {
			const result = await SELF.fetch(
				`https://worker.invalid/v1/files/${item.encoded}`,
				{
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: item.path,
				},
			);
			expect(result.status).toBe(201);
			expect(await result.json()).toMatchObject({ path: item.path });
		}
		for (const bad of ["notes/bad%ZZ.md", "notes/%2e%2e%2Fescape.md"]) {
			const result = await SELF.fetch(
				`https://worker.invalid/v1/files/${bad}`,
				{
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: "blocked",
				},
			);
			expect(result.status).toBe(400);
		}
	});
});
