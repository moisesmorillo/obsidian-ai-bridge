import { env, runInDurableObject, SELF } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

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
		expect(fifth.headers.get("Retry-After")).toBe("1");
		await fifth.text();
		for (const response of held) await response.body?.cancel();
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
