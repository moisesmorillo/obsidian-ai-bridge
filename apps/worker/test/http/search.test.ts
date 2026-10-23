import { env, runInDurableObject, SELF } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import testWorker from "@worker/test-fixtures/http-worker";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Build every ASCII letter-case combination of a file extension. */
function extensionCaseVariants(extension: string): string[] {
	return Array.from({ length: 1 << extension.length }, (_, mask) =>
		Array.from(extension, (letter, index) =>
			mask & (1 << index) ? letter.toUpperCase() : letter,
		).join(""),
	);
}

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

	it("AC-15 server: returns literal search matches and epoch-bound coverage", async () => {
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

	it("returns the canonical retry header when durable client admission is full", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		const identity: AuthorizationContext = {
			client_id: "http-test-client",
			grant_id: "http-test-grant",
			scopes: ["vault:read", "vault:write", "vault:delete"],
		};
		for (let index = 0; index < 16; index += 1) {
			const authorized = await stub.authorize(identity, {
				op: "read",
				paths: [],
				precondition: { kind: "none" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			expect(authorized.ok, `durable admission ${index}`).toBe(true);
		}
		const response = await SELF.fetch(
			"https://worker.invalid/v1/search?q=capacity",
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			error: "admission_limited",
			message: "The vault cannot accept another operation now.",
		});
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	it("AC-16 server: excludes an oversized Markdown blob from indexed search", async () => {
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

	it("applies exact size, storage, range, FTS, and coverage rules to every extension case", async () => {
		const inlineText = `matrixneedle${"x".repeat(1_000_000 - "matrixneedle".length)}`;
		const inlineBytes = new TextEncoder().encode(inlineText);
		const largeBytes = new Uint8Array(1_000_001).fill(0x78);
		largeBytes.set(new TextEncoder().encode("matrixneedle"), 0);
		largeBytes[largeBytes.length - 1] = 0x21;
		const inlineHash = await digest(inlineBytes);
		const largeHash = await digest(largeBytes);
		const variants = [
			...extensionCaseVariants("md"),
			...extensionCaseVariants("canvas"),
		];
		const expectedRows: {
			path: string;
			kind: string;
			size: number;
			hash: string;
			large: boolean;
		}[] = [];
		const markdownInlinePaths: string[] = [];

		for (const [index, extension] of variants.entries()) {
			const inlinePath = `matrix/inline-${index}.${extension}`;
			const inlineUrl = `https://worker.invalid/v1/files/${inlinePath}`;
			const inlineWrite = await SELF.fetch(inlineUrl, {
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: inlineBytes.slice(),
			});
			expect(inlineWrite.status, inlinePath).toBe(201);
			await inlineWrite.text();
			expectedRows.push({
				path: inlinePath,
				kind: "text",
				size: 1_000_000,
				hash: inlineHash,
				large: false,
			});
			if (extension.toLowerCase() === "md")
				markdownInlinePaths.push(inlinePath);

			const largePath = `matrix/large-${index}.${extension}`;
			const largeUrl = `https://worker.invalid/v1/files/${largePath}`;
			const largeWrite = await SELF.fetch(largeUrl, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": largeHash,
					"X-Content-Size": "1000001",
				},
				body: largeBytes.slice(),
			});
			expect(largeWrite.status, largePath).toBe(201);
			await largeWrite.text();
			expectedRows.push({
				path: largePath,
				kind: "blob",
				size: 1_000_001,
				hash: largeHash,
				large: true,
			});
		}

		for (const extension of ["md", "MD", "mD", "canvas", "CANVAS", "cAnVaS"]) {
			const index = variants.indexOf(extension);
			const inlineUrl = `https://worker.invalid/v1/files/matrix/inline-${index}.${extension}`;
			const inlineRead = await SELF.fetch(inlineUrl);
			expect(inlineRead.status).toBe(200);
			const inlineBody = (await inlineRead.json()) as {
				content: string;
				hash: string;
				kind: string;
				size: number;
			};
			expect(inlineBody).toMatchObject({
				content: inlineText,
				hash: inlineHash,
				kind: "text",
				size: 1_000_000,
			});
			expect(new TextEncoder().encode(inlineBody.content)).toEqual(inlineBytes);

			const largeUrl = `https://worker.invalid/v1/files/matrix/large-${index}.${extension}`;
			const firstRange = await SELF.fetch(largeUrl, {
				headers: { Range: "bytes=0-999999" },
			});
			expect(firstRange.status).toBe(206);
			expect(firstRange.headers.get("X-File-Large")).toBe("true");
			const firstBytes = new Uint8Array(await firstRange.arrayBuffer());
			const lastRange = await SELF.fetch(largeUrl, {
				headers: { Range: "bytes=1000000-1000000" },
			});
			expect(lastRange.status).toBe(206);
			const lastBytes = new Uint8Array(await lastRange.arrayBuffer());
			expect(firstBytes).toEqual(largeBytes.subarray(0, 1_000_000));
			expect(lastBytes).toEqual(largeBytes.subarray(1_000_000));
		}

		const nearPath = "matrix/near.md.backup";
		const nearBytes = new TextEncoder().encode("near");
		const nearWrite = await SELF.fetch(
			`https://worker.invalid/v1/files/${nearPath}`,
			{
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Content-SHA256": await digest(nearBytes),
					"X-Content-Size": String(nearBytes.byteLength),
				},
				body: nearBytes,
			},
		);
		expect(nearWrite.status).toBe(201);
		await nearWrite.text();
		const nearHash = await digest(nearBytes);
		const nearRead = await SELF.fetch(
			`https://worker.invalid/v1/files/${nearPath}`,
		);
		expect(nearRead.headers.get("X-File-Large")).toBe("false");
		expect(new Uint8Array(await nearRead.arrayBuffer())).toEqual(nearBytes);
		expectedRows.push({
			path: nearPath,
			kind: "blob",
			size: 4,
			hash: nearHash,
			large: false,
		});

		const manifest = await SELF.fetch("https://worker.invalid/v1/manifest");
		expect(manifest.status).toBe(200);
		const manifestBody = (await manifest.json()) as {
			entries: {
				path: string;
				kind: string;
				size: number;
				hash: string;
				large: boolean;
			}[];
		};
		expect(manifestBody.entries).toHaveLength(expectedRows.length);
		const entryByPath = new Map(
			manifestBody.entries.map((entry) => [entry.path, entry]),
		);
		for (const expected of expectedRows)
			expect(entryByPath.get(expected.path)).toMatchObject(expected);

		const search = await SELF.fetch(
			"https://worker.invalid/v1/search?q=matrixneedle&limit=50",
		);
		expect(search.status).toBe(200);
		const searchBody = (await search.json()) as {
			results: { path: string }[];
			indexed_files: number;
			unindexed_large_files: number;
		};
		expect(searchBody).toMatchObject({
			indexed_files: 4,
			unindexed_large_files: 4,
		});
		expect(new Set(searchBody.results.map((entry) => entry.path))).toEqual(
			new Set(markdownInlinePaths),
		);

		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, (_instance, state) => {
			const rows = state.storage.sql
				.exec("SELECT path,kind,size,hash FROM files ORDER BY path")
				.toArray();
			expect(rows).toHaveLength(expectedRows.length);
			expect(rows).toEqual(
				expectedRows
					.map(({ path, kind, size, hash }) => ({ path, kind, size, hash }))
					.sort((left, right) =>
						left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
					),
			);
			const indexed = state.storage.sql
				.exec("SELECT path FROM files_fts ORDER BY path")
				.toArray();
			expect(indexed).toHaveLength(4);
			expect(indexed.map((row) => row.path).sort()).toEqual(
				markdownInlinePaths.sort(),
			);
		});
	}, 60_000);

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
		const url = "https://worker.invalid/v1/files/mutable.MD";
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

	it("validates 2, 3, 200, and 201 Unicode code points at HTTP", async () => {
		const cases = [
			{ query: "😀a", status: 400, failure: "query_too_short" },
			{ query: "😀ab", status: 200 },
			{ query: `😀${"a".repeat(199)}`, status: 200 },
			{ query: `😀${"a".repeat(200)}`, status: 400, failure: "query_too_long" },
		] as const;
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		for (const item of cases) {
			const before = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec("SELECT id FROM operation_admissions")
						.toArray().length,
			);
			const response = await SELF.fetch(
				`https://worker.invalid/v1/search?q=${encodeURIComponent(item.query)}`,
			);
			expect(response.status).toBe(item.status);
			if ("failure" in item) {
				expect(await response.json()).toMatchObject({ error: item.failure });
				const after = await runInDurableObject(
					stub,
					(_instance, state) =>
						state.storage.sql
							.exec("SELECT id FROM operation_admissions")
							.toArray().length,
				);
				expect(after).toBe(before);
			} else await response.json();
		}
	});

	it("validates limit range through HTTP and accepts both endpoints", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		for (const limit of ["0", "51"]) {
			const before = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec("SELECT id FROM operation_admissions")
						.toArray().length,
			);
			const response = await SELF.fetch(
				`https://worker.invalid/v1/search?q=abc&limit=${limit}`,
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_request" });
			const after = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec("SELECT id FROM operation_admissions")
						.toArray().length,
			);
			expect(after).toBe(before);
		}
		for (const limit of ["1", "50"]) {
			const response = await SELF.fetch(
				`https://worker.invalid/v1/search?q=abc&limit=${limit}`,
			);
			expect(response.status).toBe(200);
			await response.json();
		}
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
