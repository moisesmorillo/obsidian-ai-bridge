import {
	env,
	evictDurableObject,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import {
	type AuthorizationContext,
	type ChangesPage,
	EMPTY_PAYLOAD_HASH,
	encodeReadCursor,
	formatETag,
	type HistoryPage,
	type ManifestPage,
} from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH as epoch } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

const host = "recovery.invalid";
const identity: AuthorizationContext = {
	client_id: "http-test-client",
	grant_id: "http-test-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};
/** Get the real vault authority selected by the recovery HTTP host. */
function vault() {
	return env.VAULTS.get(env.VAULTS.idFromName(host));
}
/** Execute a real request against the test Worker entry and native DO RPC. */
function get(route: string, headers?: HeadersInit) {
	return SELF.fetch(`https://${host}/v1/${route}`, { headers });
}
/** Publish exact conditional text through real HTTP and consume the mutation response. */
async function put(path: string, content: string, etag?: string) {
	const response = await SELF.fetch(`https://${host}/v1/files/${path}`, {
		method: "PUT",
		headers: {
			"X-Vault-Epoch": epoch,
			...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
		},
		body: content,
	});
	expect(response.status).toBe(etag ? 200 : 201);
	await response.text();
	const selected = response.headers.get("ETag");
	if (!selected) throw new Error("Mutation returned no ETag");
	return selected;
}
/** Seed ordered metadata and exact content in real SQLite with current feed timestamps. */
async function seedRows(count: number) {
	await runInDurableObject(vault(), async (_instance, state) => {
		const now = Date.now();
		for (let i = 1; i <= count; i++) {
			const path = `files/${String(i).padStart(4, "0")}.md`;
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 4, 'text', 'seed', 0, ?, 'fixture')",
				path,
				path,
				i,
				"a".repeat(64),
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 4, 'text', 'seed', 0, 'fixture', ?)",
				path,
				"a".repeat(64),
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, 'put', ?, 1, ?, 'fixture', ?)",
				i,
				path,
				"a".repeat(64),
				now,
			);
		}
		state.storage.sql.exec(
			"UPDATE meta SET value = ? WHERE key = 'head_seq'",
			String(count),
		);
	});
}

describe("real HTTP recovery and server acceptance", () => {
	beforeEach(async () => {
		await runInDurableObject(vault(), async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(state.storage, () => epoch, Date.now);
			state.storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id,at) VALUES ('http-revoked-grant', 1)",
			);
		});
	});
	it("retains empty-feed cursor expiry evidence after physical pruning and restart", async () => {
		await put("expired-feed.md", "expired");
		await runInDurableObject(vault(), async (instance, state) => {
			state.storage.sql.exec(
				"UPDATE changes SET at = ?",
				Date.now() - 31 * 86_400_000,
			);
			await instance.alarm();
			expect(
				state.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toEqual([]);
			expect(
				state.storage.sql
					.exec(
						"SELECT value FROM meta WHERE key = 'retention_pruned_feed_seq'",
					)
					.toArray(),
			).toEqual([{ value: "2" }]);
		});
		await evictDurableObject(vault());
		const expired = await get(`changes?epoch=${epoch}&since=0`);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toMatchObject({ error: "cursor_expired" });
	});
	it("AC-12 server: expires a 40-day feed position and returns explicit tombstones in reconciliation", async () => {
		const created = await put("deleted.md", "old");
		const deleted = await SELF.fetch(`https://${host}/v1/files/deleted.md`, {
			method: "DELETE",
			headers: { "If-Match": created },
		});
		expect(deleted.status).toBe(200);
		await deleted.text();
		await runInDurableObject(vault(), async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE changes SET at = ?",
				Date.now() - 40 * 86_400_000,
			);
		});
		const expired = await get(`changes?epoch=${epoch}&since=0`);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toMatchObject({ error: "cursor_expired" });
		const manifest = await get("manifest");
		expect(await manifest.json()).toMatchObject({
			entries: [
				{
					path: "deleted.md",
					deleted: true,
					etag: formatETag(epoch, 2),
					hash: "",
					size: 0,
				},
			],
			next_page: null,
		});
	});
	it("AC-21 server: keeps the captured page head, returns newer rows, and needs an explicit current fallback", async () => {
		await seedRows(257);
		const firstResponse = await get("manifest");
		const first = await firstResponse.json<ManifestPage>();
		expect(first.entries).toHaveLength(256);
		expect(first.head_seq).toBe(257);
		expect(first.next_page).toBeTypeOf("string");
		const updated = await put("files/0257.md", "newer", formatETag(epoch, 1));
		const secondResponse = await get(`manifest?page=${first.next_page}`);
		const second = await secondResponse.json<ManifestPage>();
		expect(second.head_seq).toBe(first.head_seq);
		expect(second.entries).toMatchObject([
			{ path: "files/0257.md", seq: 258, etag: updated },
		]);
		expect(second.next_page).toBeNull();
		await runInDurableObject(vault(), async (_instance, state) => {
			state.storage.sql.exec(
				"DELETE FROM revisions WHERE path = ? AND rev = 1",
				"files/0257.md",
			);
		});
		const pinned = await get("files/files/0257.md?rev=1", {
			"X-Vault-Epoch": epoch,
		});
		expect(pinned.status).toBe(410);
		expect(await pinned.json()).toMatchObject({ error: "revision_pruned" });
		const current = await get("files/files/0257.md");
		expect(current.headers.get("ETag")).toBe(updated);
		expect(await current.json()).toMatchObject({
			content: "newer",
			etag: updated,
		});
		const feed = await get(`changes?epoch=${epoch}&since=257`);
		expect(await feed.json()).toMatchObject({
			head_seq: 258,
			entries: [{ etag: updated, seq: 258 }],
		});
	});
	it("AC-25 server: preserves older feed identities after current content advances to revision three", async () => {
		const one = await put("note.md", "one");
		const two = await put("note.md", "two", one);
		const before = await get(`changes?epoch=${epoch}&since=1&limit=1`);
		const oldFeed = await before.json<ChangesPage>();
		const three = await put("note.md", "three", two);
		const current = await get("files/note.md");
		expect(current.headers.get("ETag")).toBe(three);
		expect(await current.json()).toMatchObject({ content: "three" });
		const after = await get(`changes?epoch=${epoch}&since=1&limit=1`);
		const replay = await after.json<ChangesPage>();
		expect(replay.entries).toEqual(oldFeed.entries);
		expect(replay.entries).toMatchObject([{ seq: 2, etag: two }]);
	});
	it("AC-40 server: preserves rename source tombstone identity below a later source revision", async () => {
		const one = await put("source.md", "source");
		const renamed = await SELF.fetch(
			`https://${host}/v1/files/source.md:rename`,
			{
				method: "POST",
				headers: { "If-Match": one, "Content-Type": "application/json" },
				body: JSON.stringify({ to: "destination.md" }),
			},
		);
		expect(renamed.status).toBe(201);
		await renamed.text();
		const recreated = await put("source.md", "later source");
		expect(recreated).toBe(formatETag(epoch, 3));
		const feed = await get(`changes?epoch=${epoch}&since=1&limit=1`);
		expect(await feed.json()).toMatchObject({
			entries: [
				{
					op: "rename",
					path: "destination.md",
					etag: formatETag(epoch, 1),
					from_path: "source.md",
					from_etag: formatETag(epoch, 2),
				},
			],
		});
		const current = await get("files/source.md");
		expect(current.headers.get("ETag")).toBe(recreated);
		expect(await current.json()).toMatchObject({ content: "later source" });
	});
	it("keeps a response head stable during real publication between native metadata batches", async () => {
		await seedRows(130);
		const response = await testWorker.fetch(
			new Request(`https://${host}/v1/manifest`),
			env,
		);
		const newer = await put("files/0130.md", "later", formatETag(epoch, 1));
		const manifest = await response.json<ManifestPage>();
		expect(manifest.head_seq).toBe(130);
		expect(manifest.entries.at(-1)).toMatchObject({ seq: 131, etag: newer });
		const feedResponse = await testWorker.fetch(
			new Request(`https://${host}/v1/changes?epoch=${epoch}&since=0`),
			env,
		);
		await put("files/0130.md", "latest", newer);
		const feed = await feedResponse.json<ChangesPage>();
		expect(feed.head_seq).toBe(131);
		expect(feed.entries.at(-1)).toMatchObject({ seq: 131, etag: newer });
		expect(feed.entries).toHaveLength(131);
	});
	it("caps feed demand at 1,000 and resumes without skipping the next sequence", async () => {
		await seedRows(1001);
		const firstResponse = await get(`changes?epoch=${epoch}&since=0`);
		const first = await firstResponse.json<ChangesPage>();
		expect(first.entries).toHaveLength(1000);
		expect(first.entries.at(-1)?.seq).toBe(1000);
		const second = await get(`changes?epoch=${epoch}&since=1000`);
		expect(await second.json()).toMatchObject({
			entries: [{ seq: 1001 }],
			head_seq: 1001,
		});
	});
	it("caps history at 256 and keeps its revision ceiling after concurrent publication", async () => {
		const created = await put("history.md", "seed");
		await runInDurableObject(vault(), async (_instance, state) => {
			for (let rev = 2; rev <= 257; rev++)
				state.storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) SELECT path,?,hash,size,kind,content,deleted,origin,at FROM revisions WHERE path='history.md' AND rev=1",
					rev,
				);
			state.storage.sql.exec(
				"UPDATE files SET rev=257 WHERE path='history.md'",
			);
		});
		expect(created).toBe(formatETag(epoch, 1));
		const firstResponse = await get("history/history.md");
		const first = await firstResponse.json<HistoryPage>();
		expect(first.entries).toHaveLength(256);
		expect(first.next_page).toBeTypeOf("string");
		await put("history.md", "later", formatETag(epoch, 257));
		const second = await get(`history/history.md?page=${first.next_page}`);
		expect(await second.json()).toMatchObject({
			entries: [{ etag: formatETag(epoch, 257) }],
			next_page: null,
		});
	});
	it("returns canonical recovery failures for old epochs, future cursors, and wrong token bindings", async () => {
		const oldEpoch = "a".repeat(32);
		const manifestOld = encodeReadCursor({
			version: 1,
			kind: "manifest",
			epoch: oldEpoch,
			head_seq: 0,
			last_path: "a.md",
		});
		const history = encodeReadCursor({
			version: 1,
			kind: "history",
			epoch,
			head_seq: 0,
			path: "a.md",
			upper_etag: formatETag(epoch, 1),
			last_etag: formatETag(epoch, 1),
		});
		for (const [route, status, error] of [
			[`manifest?page=${manifestOld}`, 409, "epoch_mismatch"],
			[`changes?epoch=${oldEpoch}&since=0`, 409, "epoch_mismatch"],
			[`changes?epoch=${epoch}&since=1`, 400, "invalid_request"],
			[`manifest?page=${history}`, 400, "invalid_request"],
			[`history/b.md?page=${history}`, 400, "invalid_request"],
			[`manifest?page=${"a".repeat(4097)}`, 400, "invalid_request"],
		] as const) {
			const response = await get(route);
			expect(response.status, route.slice(0, 100)).toBe(status);
			expect(await response.json()).toMatchObject({
				error,
				...(error === "epoch_mismatch" ? { current_epoch: epoch } : {}),
			});
		}
	});
	it("checks read-only, write-only, and revoked identities on every read route", async () => {
		await put("scope.md", "read");
		for (const route of [
			"vault",
			"manifest",
			`changes?epoch=${epoch}&since=0`,
			"history/scope.md",
			"files/scope.md",
			"files/scope.md?rev=1",
		]) {
			for (const [name, status] of [
				["read", 200],
				["write", 403],
				["revoked", 401],
			] as const) {
				const response = await get(route, {
					"X-Test-Identity": name,
					"X-Vault-Epoch": epoch,
				});
				expect(response.status, `${route} ${name}`).toBe(status);
				await response.text();
			}
		}
	});
	it("fences current and exact native content selection with the active path ticket", async () => {
		await put("ticket.md", "content");
		const begun = await vault().authorize(identity, {
			op: "read",
			paths: ["ticket.md"],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(begun.ok).toBe(true);
		if (!begun.ok) return;
		const ticket = begun.ticket.id;
		for (const selection of [
			{ path: "ticket.md" },
			{ path: "ticket.md", epoch, rev: 1 },
		]) {
			expect(await vault().readText(identity, selection, ticket)).toMatchObject(
				{ ok: true, body: { etag: formatETag(epoch, 1) } },
			);
		}
		expect(
			await vault().readText(identity, { path: "another.md" }, ticket),
		).toMatchObject({ ok: false, failure: { kind: "invalid_ticket" } });
		await vault().finishAdmission(identity, ticket, "settled");
		expect(
			await vault().readText(identity, { path: "ticket.md" }, ticket),
		).toMatchObject({ ok: false, failure: { kind: "invalid_ticket" } });
	});
	it("streams inline control characters with UTF-16 range semantics and bounded encoded chunks", async () => {
		const content = `${"\u0000".repeat(8191)}😀${"\u0001".repeat(150_000)}`;
		const etag = await put("escaped.md", content);
		const response = await testWorker.fetch(
			new Request(`https://${host}/v1/files/escaped.md`),
			env,
		);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let json = "";
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			expect(item.value.byteLength).toBeLessThanOrEqual(65_536);
			json += decoder.decode(item.value, { stream: true });
		}
		json += decoder.decode();
		expect(JSON.parse(json)).toMatchObject({ content, etag });
		const half = await get("files/escaped.md?offset=8191&length=1");
		expect(await half.json()).toMatchObject({
			content: "\ud83d",
			offset: 8191,
			length: 1,
			etag,
		});
	});
	it("keeps native content and blob tickets bound to path, grant, deadline, and current policy", async () => {
		await put("native.md", "content");
		for (const mode of ["blob", "expired", "revoked", "grant"] as const) {
			const begun = await vault().authorize(identity, {
				op: "read",
				paths: ["native.md"],
				precondition: { kind: "none" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			if (!begun.ok) throw new Error("Read admission denied");
			const ticket = begun.ticket.id;
			if (mode === "expired")
				await runInDurableObject(vault(), async (_instance, state) => {
					state.storage.sql.exec(
						"UPDATE operation_admissions SET expires_at=1 WHERE id=?",
						ticket,
					);
				});
			if (mode === "revoked")
				await runInDurableObject(vault(), async (_instance, state) => {
					state.storage.sql.exec(
						"INSERT INTO revoked_grants(grant_id,at) VALUES (?,1)",
						identity.grant_id,
					);
				});
			const selectedIdentity =
				mode === "grant" ? { ...identity, grant_id: "other-grant" } : identity;
			if (mode === "blob") {
				await runInDurableObject(vault(), async (_instance, state) => {
					state.storage.sql.exec(
						"UPDATE files SET kind='blob',content=NULL,blob_hash=hash WHERE path='native.md'",
					);
				});
				expect(
					await vault().readBlobMetadata(
						identity,
						{ path: "native.md" },
						ticket,
					),
				).toMatchObject({ ok: true, body: { kind: "blob" } });
				await vault().finishAdmission(identity, ticket, "settled");
				expect(
					await vault().readBlobMetadata(
						identity,
						{ path: "native.md" },
						ticket,
					),
				).toMatchObject({ ok: false, failure: { kind: "invalid_ticket" } });
			} else {
				for (const exact of [false, true]) {
					const selection = {
						path: "native.md",
						...(exact ? { epoch, rev: 1 } : {}),
					};
					expect(
						await vault().readText(selectedIdentity, selection, ticket),
					).toMatchObject({
						ok: false,
						failure: {
							kind: mode === "revoked" ? "revoked" : "invalid_ticket",
						},
					});
					expect(
						await vault().readBlobMetadata(selectedIdentity, selection, ticket),
					).toMatchObject({
						ok: false,
						failure: {
							kind: mode === "revoked" ? "revoked" : "invalid_ticket",
						},
					});
				}
			}
			await runInDurableObject(vault(), async (_instance, state) => {
				state.storage.sql.exec(
					"DELETE FROM revoked_grants WHERE grant_id=?",
					identity.grant_id,
				);
				state.storage.sql.exec(
					"DELETE FROM operation_admissions WHERE id=?",
					ticket,
				);
			});
		}
	});
	it("retains unknown read RPC results at their original durable deadlines", async () => {
		await put("unknown.md", "text");
		for (const [route, method] of [
			["files/unknown.md", "readText"],
			["manifest", "readBatch"],
			["vault", "readVault"],
		] as const) {
			const before = Date.now();
			const response = await get(route, { "X-Test-Fail-RPC": method });
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: "internal_error" });
			const rows = await runInDurableObject(vault(), async (_instance, state) =>
				state.storage.sql
					.exec("SELECT admitted_at,expires_at,state FROM operation_admissions")
					.toArray(),
			);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(Number(row.expires_at) - Number(row.admitted_at)).toBe(60_000);
				expect(Number(row.admitted_at)).toBeGreaterThanOrEqual(before);
			}
			await runInDurableObject(vault(), async (_instance, state) => {
				state.storage.sql.exec("DELETE FROM operation_admissions");
			});
		}
	});
	it("settles real durable admissions only after metadata and content response EOF or cancellation", async () => {
		await put("owned.md", "text");
		for (const route of [
			"vault",
			"manifest",
			`changes?epoch=${epoch}&since=0`,
			"history/owned.md",
			"files/owned.md",
			"files/owned.md?rev=1",
		]) {
			const response = await testWorker.fetch(
				new Request(`https://${host}/v1/${route}`, {
					headers: { "X-Vault-Epoch": epoch },
				}),
				env,
			);
			expect(response.status).toBe(200);
			const count = await runInDurableObject(
				vault(),
				async (_instance, state) =>
					state.storage.sql
						.exec("SELECT count(*) AS n FROM operation_admissions")
						.one().n,
			);
			expect(count, route).toBe(1);
			await response.body?.cancel();
			const after = await runInDurableObject(
				vault(),
				async (_instance, state) =>
					state.storage.sql
						.exec("SELECT count(*) AS n FROM operation_admissions")
						.one().n,
			);
			expect(after, route).toBe(0);
		}
	});
	it("shares metadata slots with current, exact, whole-blob, and range responses across vault hosts", async () => {
		const bytes = new Uint8Array(100).fill(42);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const created = await SELF.fetch(`https://${host}/v1/files/shared.bin`, {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": epoch,
				"X-Content-SHA256": hash,
				"X-Content-Size": "100",
			},
			body: bytes,
		});
		expect(created.status).toBe(201);
		await created.text();
		const selections: { query: string; headers: Record<string, string> }[] = [
			{ query: "", headers: {} },
			{ query: "?rev=1", headers: { "X-Vault-Epoch": epoch } },
			{ query: "", headers: { Range: "bytes=0-9" } },
		];
		for (const selection of selections) {
			const held: Response[] = [];
			try {
				for (let i = 0; i < 3; i++)
					held.push(
						await testWorker.fetch(
							new Request(`https://${host}/v1/vault`),
							env,
						),
					);
				const blob = await testWorker.fetch(
					new Request(`https://${host}/v1/files/shared.bin${selection.query}`, {
						headers: selection.headers,
					}),
					env,
				);
				held.push(blob);
				expect(blob.status).toBe(selection.headers.Range ? 206 : 200);
				expect(blob.headers.get("ETag")).toBe(created.headers.get("ETag"));
				expect(blob.headers.get("Content-Length")).toBe(
					selection.headers.Range ? "10" : "100",
				);
				for (const route of [
					"https://different.invalid/v1/manifest",
					`https://${host}/v1/files/shared.bin`,
				]) {
					const refused = await testWorker.fetch(new Request(route), env);
					expect(refused.status).toBe(429);
					expect(refused.headers.get("Retry-After")).toBe("1");
					await refused.text();
				}
			} finally {
				for (const response of held) await response.body?.cancel();
			}
		}
	});
	it("reports the current epoch when authority changes after content admission", async () => {
		await put("restored.md", "old epoch");
		const begun = await vault().authorize(identity, {
			op: "read",
			paths: ["restored.md"],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		if (!begun.ok) throw new Error("Read admission denied");
		const currentEpoch = "b".repeat(32);
		await runInDurableObject(vault(), async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE meta SET value=? WHERE key='epoch'",
				currentEpoch,
			);
		});
		for (const method of ["readText", "readBlobMetadata"] as const) {
			const result = await vault()[method](
				identity,
				{ path: "restored.md", epoch, rev: 1 },
				begun.ticket.id,
			);
			expect(result).toMatchObject({
				ok: false,
				failure: { kind: "epoch_mismatch", current_epoch: currentEpoch },
			});
		}
	});

	it("rejects noncanonical base64url cursor padding bits at the HTTP boundary", async () => {
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		for (const path of ["a.md", "aa.md", "aaa.md"]) {
			const token = encodeReadCursor({
				version: 1,
				kind: "manifest",
				epoch,
				head_seq: 0,
				last_path: path,
			});
			if (token.length % 4 === 0) continue;
			const alternate =
				token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1) ?? "") + 1];
			const response = await get(`manifest?page=${alternate}`);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_request" });
		}
	});
});
