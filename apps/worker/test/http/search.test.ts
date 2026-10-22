import { env, runInDurableObject, SELF } from "cloudflare:test";
import { pathKey } from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Hash exact blob bytes for the AC-16 search-exclusion request. */
async function digest(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new Uint8Array(bytes).buffer,
	);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

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

	it("excludes an AC-16 oversized Markdown blob and reports its coverage", async () => {
		const bytes = new Uint8Array(1_500_000).fill(0x61);
		bytes.set(new TextEncoder().encode("needle"), 0);
		const response = await SELF.fetch(
			"https://worker.invalid/v1/files/oversized.md",
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
		expect(response.status).toBe(201);
		await response.text();
		const search = await SELF.fetch(
			"https://worker.invalid/v1/search?q=needle",
		);
		expect(search.status).toBe(200);
		expect(await search.json()).toMatchObject({
			results: [],
			indexed_files: 0,
			unindexed_large_files: 1,
		});
	});

	it("uses the default 20 limit and accepts the maximum 50 limit", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, (_instance, state) => {
			for (let index = 0; index < 25; index += 1) {
				const path = `notes/default-${String(index).padStart(2, "0")}.md`;
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 14, 'text', 'default needle', 0, 10, 'seed')",
					path,
					pathKey(path),
					index + 1,
					"a".repeat(64),
				);
				state.storage.sql.exec(
					"INSERT INTO files_fts(path,content) VALUES (?, 'default needle')",
					path,
				);
			}
		});
		const defaultResponse = await SELF.fetch(
			"https://worker.invalid/v1/search?q=needle",
		);
		expect(defaultResponse.status).toBe(200);
		expect(
			((await defaultResponse.json()) as { results: unknown[] }).results,
		).toHaveLength(20);
		const maximumResponse = await SELF.fetch(
			"https://worker.invalid/v1/search?q=needle&limit=50",
		);
		expect(maximumResponse.status).toBe(200);
		expect(
			((await maximumResponse.json()) as { results: unknown[] }).results,
		).toHaveLength(25);
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

	it("shares four response slots across search, manifest, vault, and content reads", async () => {
		const created = await SELF.fetch(
			"https://worker.invalid/v1/files/slot.md",
			{
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "slot content",
			},
		);
		expect(created.status).toBe(201);
		await created.text();
		const routes = [
			"/v1/search?q=slot",
			"/v1/manifest",
			"/v1/vault",
			"/v1/files/slot.md",
		];
		const responses = await Promise.all(
			routes.map((route) =>
				testWorker.fetch(new Request(`https://worker.invalid${route}`), env),
			),
		);
		expect(responses.map((response) => response.status)).toEqual([
			200, 200, 200, 200,
		]);
		const limited = await testWorker.fetch(
			new Request("https://worker.invalid/v1/search?q=slot"),
			env,
		);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
		await limited.text();
		for (const response of responses) await response.text();
	});

	it("keeps an unknown post-search RPC outcome charged and returns a safe error", async () => {
		const response = await testWorker.fetch(
			new Request("https://worker.invalid/v1/search?q=private-query", {
				headers: { "X-Test-Fail-RPC": "search" },
			}),
			env,
		);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toContain("internal_error");
		for (const secret of ["private-query", "token", "SQL", "exception"])
			expect(text).not.toContain(secret);
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const active = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec(
					"SELECT id, expires_at FROM operation_admissions WHERE state = 'active'",
				)
				.toArray(),
		);
		expect(active).toHaveLength(1);
		expect(active[0]?.expires_at).toBeGreaterThan(Date.now());
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
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const admissions = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("SELECT id FROM operation_admissions").toArray(),
		);
		expect(admissions).toEqual([]);
	});
});
