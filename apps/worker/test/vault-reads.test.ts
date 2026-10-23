import { env, runInDurableObject } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

const context: AuthorizationContext = {
	client_id: "reads-client",
	grant_id: "reads-grant",
	scopes: ["vault:read"],
};

/** Verify native authoritative reads against the real SQLite Durable Object. */
describe("native authoritative reads", () => {
	it("returns aggregate empty counts and published limits", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const result = await stub.readVault(context, authorized.ticket.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body).toMatchObject({
			head_seq: 0,
			counts: { live: 0, deleted: 0 },
			limits: {
				manifest_page: 256,
				feed_page: 1000,
				text_bytes: 1_000_000,
				blob_bytes: 25_000_000,
			},
			capacity: {
				database_bytes: expect.any(Number),
				database_limit_bytes: 2_000_000_000,
				live_file_limit: 10_000,
				history_pressure_bytes: 0,
				referenced_blob_bytes: 0,
			},
			attention: [],
		});
		const batch = await stub.readBatch(
			context,
			{
				collection: "manifest",
				epoch: result.body.epoch,
				head_seq: result.body.head_seq,
				after_path: null,
				limit: 64,
			},
			authorized.ticket.id,
		);
		expect(batch).toEqual({
			ok: true,
			body: { collection: "manifest", rows: [] },
		});
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});

	it("returns metadata-only keyset batches with tombstones and SQLite binary order", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => "0123456789abcdef0123456789abcdef",
				() => 10_000,
			);
			for (let index = 0; index < 65; index += 1) {
				const path = `notes/item-${String(index).padStart(3, "0")}.md`;
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 4, 'text', 'text', 0, 10, 'seed')",
					path,
					pathKey(path),
					index + 1,
					"a".repeat(64),
				);
			}
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 2, 66, '', 0, 'text', NULL, 1, 10, 'seed')",
				"notes/deleted.md",
				pathKey("notes/deleted.md"),
			);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 67, ?, 1000001, 'blob', NULL, 0, 10, 'seed')",
				"media/large.md",
				pathKey("media/large.md"),
				"b".repeat(64),
			);
			state.storage.sql.exec(
				"INSERT INTO blob_refs(hash,size,first_ref_at) VALUES (?, 1000001, 10)",
				"b".repeat(64),
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '67' WHERE key = 'head_seq'",
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
		const summary = await stub.readVault(context, authorized.ticket.id);
		expect(summary.ok).toBe(true);
		if (!summary.ok) return;
		expect(summary.body.counts).toEqual({ live: 66, deleted: 1 });
		expect(summary.body.capacity.referenced_blob_bytes).toBe(1_000_001);
		const first = await stub.readBatch(
			context,
			{
				collection: "manifest",
				epoch: summary.body.epoch,
				head_seq: summary.body.head_seq,
				after_path: null,
				limit: 64,
			},
			authorized.ticket.id,
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.body.collection).toBe("manifest");
		if (first.body.collection !== "manifest") return;
		expect(first.body.rows).toHaveLength(65);
		expect(first.body.rows[0]).toMatchObject({
			path: "media/large.md",
			kind: "blob",
			large: true,
		});
		expect(first.body.rows[0]).not.toHaveProperty("content");
		expect(
			first.body.rows.find((row) => row.path === "notes/deleted.md"),
		).toMatchObject({
			deleted: true,
			hash: "",
			size: 0,
			large: false,
		});
		expect(first.body.rows[0]).not.toHaveProperty("content");
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});

	it("preserves canonical policy failures across the Durable Object read boundary", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const result = await stub.readBatch(
			context,
			{
				collection: "manifest",
				epoch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				head_seq: 0,
				after_path: null,
				limit: 64,
			},
			authorized.ticket.id,
		);
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "epoch_mismatch", current_epoch: expect.any(String) },
		});
	});
});
