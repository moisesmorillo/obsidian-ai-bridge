import { env, runInDurableObject } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const context: AuthorizationContext = {
	client_id: "search-client",
	grant_id: "search-grant",
	scopes: ["vault:read"],
};

/** Verify literal native FTS selection through the real SQLite Durable Object. */
describe("native vault search", () => {
	it("returns a bounded current Markdown result with exact epoch metadata", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, 15, 'text', ?, 0, 10, 'seed')",
				"notes/search.md",
				pathKey("notes/search.md"),
				"a".repeat(64),
				"café literal AND text",
			);
			state.storage.sql.exec(
				"INSERT INTO files_fts(path,content) VALUES (?, ?)",
				"notes/search.md",
				"café literal AND text",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'head_seq'",
			);
		});
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const response = await stub.search(
			context,
			{ query: "cafe", limit: 20 },
			authorized.ticket.id,
		);
		expect(response).toMatchObject({
			ok: true,
			body: {
				epoch,
				results: [
					{
						path: "notes/search.md",
						etag: `"${epoch}.1"`,
						snippet: expect.stringContaining("café"),
					},
				],
				indexed_files: 1,
				unindexed_large_files: 0,
			},
		});
		if (response.ok)
			expect(Number.isFinite(response.body.results[0]?.score)).toBe(true);
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});

	it("counts only live indexed Markdown and oversized Markdown blobs", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			const rows = [
				["live.md", "text", 20, 0, "literal live match"],
				["canvas.canvas", "text", 20, 0, "literal canvas match"],
				["large.md", "blob", 1_500_000, 0, null],
				["gone.md", "text", 0, 1, null],
				["file.txt", "blob", 1_500_000, 0, null],
			] as const;
			for (const [path, kind, size, deleted, content] of rows) {
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, 10, 'seed')",
					path,
					pathKey(path),
					deleted ? "" : "a".repeat(64),
					size,
					kind,
					content,
					deleted,
				);
				if (!deleted && kind === "text" && path.endsWith(".md"))
					state.storage.sql.exec(
						"INSERT INTO files_fts(path,content) VALUES (?, ?)",
						path,
						content,
					);
			}
		});
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const response = await stub.search(
			context,
			{ query: "literal", limit: 20 },
			authorized.ticket.id,
		);
		expect(response).toMatchObject({
			ok: true,
			body: {
				results: [{ path: "live.md" }],
				indexed_files: 1,
				unindexed_large_files: 1,
			},
		});
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});
});
