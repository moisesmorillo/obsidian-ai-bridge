import { env, runInDurableObject, SELF } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Exercise strict search requests against the real Worker and Vault Durable Object. */
describe("literal search HTTP route", () => {
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

	it("returns literal matching text and epoch-bound coverage", async () => {
		const write = await SELF.fetch(
			"https://worker.invalid/v1/files/search.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: 'Cafe café AND "quoted" OR * - : /v1/files If-Match bge-m3 wrangler.jsonc SQL OR 1=1 --',
			},
		);
		await write.text();
		for (const query of [
			"cafe",
			"AND",
			'"quoted"',
			"OR ",
			"* - :",
			"/v1/files",
			"If-Match",
			"bge-m3",
			"wrangler.jsonc",
			"1=1 --",
		]) {
			const response = await SELF.fetch(
				`https://worker.invalid/v1/search?q=${encodeURIComponent(query)}`,
			);
			expect(response.status, query).toBe(200);
			const body = (await response.json()) as {
				epoch: string;
				results: { etag: string; snippet: string; score: number }[];
				indexed_files: number;
			};
			expect(body.epoch).toBe(TEXT_FIXTURE_EPOCH);
			expect(body.indexed_files).toBe(1);
			expect(body.results[0]?.etag).toBe(write.headers.get("ETag"));
			expect(body.results[0]?.snippet).not.toMatch(/<b>|<\/b>/);
			expect(Number.isFinite(body.results[0]?.score)).toBe(true);
		}
	});

	it("keeps indexed results in step with update and delete mutations", async () => {
		const url = "https://worker.invalid/v1/files/mutable.md";
		const first = await SELF.fetch(url, {
			method: "PUT",
			headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			body: "firstword initial text",
		});
		await first.text();
		const updated = await SELF.fetch(url, {
			method: "PUT",
			headers: {
				"If-Match": first.headers.get("ETag") ?? "",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "secondword changed text",
		});
		await updated.text();
		const stale = await SELF.fetch(
			"https://worker.invalid/v1/search?q=firstword",
		);
		expect(((await stale.json()) as { results: unknown[] }).results).toEqual(
			[],
		);
		const current = await SELF.fetch(
			"https://worker.invalid/v1/search?q=secondword",
		);
		expect(
			((await current.json()) as { results: { etag: string }[] }).results[0]
				?.etag,
		).toBe(updated.headers.get("ETag"));
		const deleted = await SELF.fetch(url, {
			method: "DELETE",
			headers: { "If-Match": updated.headers.get("ETag") ?? "" },
		});
		expect(deleted.status).toBe(200);
		await deleted.text();
		const afterDelete = await SELF.fetch(
			"https://worker.invalid/v1/search?q=secondword",
		);
		expect(
			((await afterDelete.json()) as { results: unknown[] }).results,
		).toEqual([]);
	});

	it("shares the four response slots with other read routes", async () => {
		const responses = await Promise.all(
			Array.from({ length: 5 }, () =>
				testWorker.fetch(
					new Request("https://worker.invalid/v1/search?q=abc"),
					env,
				),
			),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 200, 200, 200, 429,
		]);
		for (const response of responses) await response.text();
	});

	it("checks read scope before native search demand", async () => {
		const response = await SELF.fetch(
			"https://worker.invalid/v1/search?q=abc",
			{
				headers: { "X-Test-Identity": "write" },
			},
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "forbidden_scope" });
	});

	it("rejects malformed and noncanonical query parameters before reading", async () => {
		for (const query of [
			"",
			"q=ab",
			"q=abc&limit=01",
			"q=abc&limit=1.0",
			"q=abc&limit=+1",
			"q=abc&other=x",
			"q=abc&q=def",
		]) {
			const response = await SELF.fetch(
				`https://worker.invalid/v1/search?${query}`,
			);
			expect(response.status).toBe(400);
			await response.text();
		}
		const short = await SELF.fetch("https://worker.invalid/v1/search?q=ab");
		expect(short.status).toBe(400);
		expect(await short.json()).toMatchObject({ error: "query_too_short" });
		const long = await SELF.fetch(
			`https://worker.invalid/v1/search?q=${"a".repeat(201)}`,
		);
		expect(long.status).toBe(400);
		expect(await long.json()).toMatchObject({ error: "query_too_long" });
	});
});
