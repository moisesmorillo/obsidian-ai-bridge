import { env, runInDurableObject, SELF } from "cloudflare:test";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import { Vault } from "@worker/infrastructure/durable-object/vault";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Exercise bounded public reads through Worker routing and the real Vault Durable Object. */
describe("bounded read HTTP routes", () => {
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

	it("returns canonical vault, manifest, feed, and history pages", async () => {
		const created = await SELF.fetch(
			"https://worker.invalid/v1/files/note.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "read me",
			},
		);
		await created.text();
		const vault = await SELF.fetch("https://worker.invalid/v1/vault");
		expect(vault.status).toBe(200);
		expect(await vault.json()).toMatchObject({
			epoch: TEXT_FIXTURE_EPOCH,
			head_seq: 1,
		});

		const manifest = await SELF.fetch("https://worker.invalid/v1/manifest");
		expect(manifest.status).toBe(200);
		expect(await manifest.json()).toMatchObject({
			epoch: TEXT_FIXTURE_EPOCH,
			head_seq: 1,
			entries: [
				{ path: "note.md", etag: created.headers.get("ETag"), size: 7 },
			],
			next_page: null,
		});

		const feed = await SELF.fetch(
			`https://worker.invalid/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0`,
		);
		expect(feed.status).toBe(200);
		expect(await feed.json()).toMatchObject({
			epoch: TEXT_FIXTURE_EPOCH,
			head_seq: 1,
			entries: [{ path: "note.md", etag: created.headers.get("ETag") }],
		});

		const history = await SELF.fetch(
			"https://worker.invalid/v1/history/note.md",
		);
		expect(history.status).toBe(200);
		expect(await history.json()).toMatchObject({
			epoch: TEXT_FIXTURE_EPOCH,
			entries: [{ etag: created.headers.get("ETag"), size: 7 }],
			next_page: null,
		});
	});

	it("sends no-transform on every JSON read and read failure", async () => {
		const created = await SELF.fetch(
			"https://worker.invalid/v1/files/note.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "read me",
			},
		);
		await created.text();
		const routes = [
			["/v1/vault", 200],
			["/v1/manifest", 200],
			[`/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0`, 200],
			["/v1/history/note.md", 200],
			["/v1/search?q=read", 200],
			["/v1/changes", 400],
			["/v1/manifest?unknown=1", 400],
			["/v1/search?unknown=1", 400],
			["/v1/files/missing.md", 404],
			["/v1/files/note.md?rev=abc", 400],
		] as const;
		for (const [route, status] of routes) {
			const response = await SELF.fetch(`https://worker.invalid${route}`);
			expect({ route, status: response.status }).toEqual({ route, status });
			expect({
				route,
				cacheControl: response.headers.get("Cache-Control"),
			}).toEqual({ route, cacheControl: "no-transform" });
			expect(response.headers.get("Content-Type")).toMatch(
				/^application\/json/,
			);
			await response.text();
		}
	});

	it("holds four response slots while a page remains unread", async () => {
		const responses = await Promise.all(
			Array.from({ length: 5 }, () =>
				testWorker.fetch(
					new Request("https://worker.invalid/v1/manifest"),
					env,
				),
			),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 200, 200, 200, 429,
		]);
		for (const response of responses) await response.text();
	});

	it("shares read slots across content, exact content, and metadata routes", async () => {
		const created = await SELF.fetch(
			"https://worker.invalid/v1/files/shared.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "text",
			},
		);
		await created.text();
		const held = [];
		for (const route of [
			"/v1/files/shared.md",
			"/v1/files/shared.md?rev=1",
			"/v1/vault",
			"/v1/history/shared.md",
		]) {
			const response = await testWorker.fetch(
				new Request(`https://worker.invalid${route}`, {
					headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				}),
				env,
			);
			expect(response.status).toBe(200);
			held.push(response);
		}
		const fifth = await testWorker.fetch(
			new Request("https://another.invalid/v1/manifest"),
			env,
		);
		expect(fifth.status).toBe(429);
		expect(fifth.headers.get("Retry-After")).toBe("2");
		await fifth.text();
		for (const response of held) await response.body?.cancel();
		// A native body observes cancellation at its next write; await cancel does not join cleanup.
		await vi.waitFor(() =>
			expect(readSlotCapacitySnapshot().held_rest_slots).toBe(0),
		);
		const next = await testWorker.fetch(
			new Request("https://worker.invalid/v1/manifest"),
			env,
		);
		expect(next.status).toBe(200);
		await next.text();
	});

	it("rejects noncanonical content numbers before selection", async () => {
		for (const selector of [
			"offset=01",
			"length=1e2",
			"rev=+1",
			"offset=0x10",
			"length=",
			"offset=-0",
		]) {
			const response = await SELF.fetch(
				`https://worker.invalid/v1/files/absent.md?${selector}`,
				{ headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH } },
			);
			expect(response.status, selector).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_request" });
		}
	});

	it("rejects repeated, unknown, malformed, and over-limit read selectors", async () => {
		for (const route of [
			"/v1/vault?unknown=1",
			"/v1/vault?page=a",
			"/v1/manifest?page=a&page=b",
			"/v1/manifest?unknown=1",
			"/v1/changes?epoch=bad&since=0",
			"/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=-1",
			"/v1/changes?epoch=0123456789abcdef0123456789abcdef&since=0&limit=1001",
			"/v1/history/note.md?page=%",
		]) {
			const response = await SELF.fetch(`https://worker.invalid${route}`);
			expect(response.status, route).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_request" });
		}
	});
});

/** Seed a full feed page of live text rows through native SQL. */
async function seedFeed(count: number): Promise<void> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.transactionSync(() => {
			for (let seq = 1; seq <= count; seq += 1) {
				const path = `Agents/feed/${String(seq).padStart(5, "0")}-entry.md`;
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 4, 'text', 'seed', 0, 10000, 'fixture')",
					path,
					path,
					seq,
					"a".repeat(64),
				);
				state.storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 4, 'text', 'seed', 0, 'fixture', 10000)",
					path,
					"a".repeat(64),
				);
				state.storage.sql.exec(
					"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, 'put', ?, 1, ?, 'fixture', ?)",
					seq,
					path,
					"a".repeat(64),
					Date.now(),
				);
			}
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'head_seq'",
				String(count),
			);
		});
	});
}

describe("full feed page cost", () => {
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
		await seedFeed(1000);
	});

	it("streams a full 1,000-entry feed page in coalesced bounded chunks", async () => {
		const response = await SELF.fetch(
			`https://worker.invalid/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0&limit=1000`,
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		const sizes: number[] = [];
		const parts: Uint8Array[] = [];
		while (reader) {
			const item = await reader.read();
			if (item.done) break;
			sizes.push(item.value.byteLength);
			parts.push(item.value);
		}
		const body = JSON.parse(
			new TextDecoder().decode(
				parts.reduce((joined, part) => {
					const next = new Uint8Array(joined.byteLength + part.byteLength);
					next.set(joined);
					next.set(part, joined.byteLength);
					return next;
				}, new Uint8Array()),
			),
		);
		expect(body.entries).toHaveLength(1000);
		expect(body.entries[999].seq).toBe(1000);
		// About 219 KB. The Worker coalesces into 16 KB chunks with one flush per 64-row storage batch;
		// the local service binding re-chunks reads at 4,096 bytes. Token-sized chunks gave 54,017.
		expect(sizes.length).toBeLessThanOrEqual(128);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(65_536);
	});

	it("returns REST read capacity promptly after a client cancels a feed page", async () => {
		const batches = vi.spyOn(Vault.prototype, "readBatch");
		const response = await SELF.fetch(
			`https://worker.invalid/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0&limit=1000`,
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		expect((await reader?.read())?.done).toBe(false);
		expect(readSlotCapacitySnapshot().held_rest_slots).toBe(1);
		expect(admissionByteSnapshot().rest_read_bytes).toBe(4_500_000);
		await reader?.cancel();
		const deadline = Date.now() + 2_000;
		while (
			(admissionByteSnapshot().rest_read_bytes !== 0 ||
				readSlotCapacitySnapshot().held_rest_slots !== 0) &&
			Date.now() < deadline
		)
			await scheduler.wait(20);
		expect(admissionByteSnapshot().rest_read_bytes).toBe(0);
		expect(readSlotCapacitySnapshot().held_rest_slots).toBe(0);
		// Source-side evidence: a full 1,000-entry page needs 16 batch RPCs of 64 rows.
		const cancelledBatches = batches.mock.calls.length;
		await scheduler.wait(100);
		expect(batches.mock.calls.length).toBe(cancelledBatches);
		expect(cancelledBatches).toBeGreaterThan(0);
		expect(cancelledBatches).toBeLessThan(16);
		batches.mockRestore();
	});
});
