import {
	type AuthorizationContext,
	formatETag,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import {
	NATIVE_READ_CONTEXT,
	NATIVE_READ_EPOCH,
	seedReadChange,
	withNativeReadFixture,
} from "./fixtures/reads";

const day = 24 * 60 * 60 * 1000;

/** Build one bounded feed batch request at a fixed read identity. */
function changesRequest(headSeq: number, afterSeq: number) {
	return {
		collection: "changes" as const,
		epoch: NATIVE_READ_EPOCH,
		head_seq: headSeq,
		after_seq: afterSeq,
		limit: 64,
	};
}

describe("native read feed admission and retention", () => {
	it("preserves the inclusive 30-day boundary and accepts the cursor before it", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				const now = 40 * day;
				const cutoff = now - 30 * day;
				setNow(now);
				seedReadChange(storage, { seq: 1, at: cutoff - 1 });
				seedReadChange(storage, { seq: 2, at: cutoff });
				seedReadChange(storage, { seq: 3, at: cutoff + 1 });
				storage.sql.exec("UPDATE meta SET value = '3' WHERE key = 'head_seq'");
				const ticket = await authorizeRead();
				const result = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					changesRequest(3, 1),
					ticket,
				);
				expect(result).toMatchObject({
					collection: "changes",
					rows: [{ seq: 2 }, { seq: 3 }],
				});
			},
		);
	});

	it("does not return expired later sequences after a clock rollback", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				const now = 40 * day;
				const cutoff = now - 30 * day;
				setNow(now);
				seedReadChange(storage, { seq: 1, at: cutoff + 1 });
				seedReadChange(storage, { seq: 2, at: cutoff - 1 });
				seedReadChange(storage, { seq: 3, at: cutoff + 2 });
				storage.sql.exec("UPDATE meta SET value = '3' WHERE key = 'head_seq'");
				const ticket = await authorizeRead();
				await expect(
					reads.readBatch(NATIVE_READ_CONTEXT, changesRequest(3, 1), ticket),
				).rejects.toMatchObject({ failure: { kind: "cursor_expired" } });
			},
		);
	});

	it("expires a 40-day cursor and a cursor before a pruned empty feed", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				const now = 40 * day;
				setNow(now);
				seedReadChange(storage, { seq: 1, at: now - 40 * day });
				storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'head_seq'");
				const oldTicket = await authorizeRead();
				await expect(
					reads.readBatch(NATIVE_READ_CONTEXT, changesRequest(1, 0), oldTicket),
				).rejects.toMatchObject({ failure: { kind: "cursor_expired" } });
				storage.sql.exec("DELETE FROM changes");
				storage.sql.exec("UPDATE meta SET value = '5' WHERE key = 'head_seq'");
				const emptyTicket = await authorizeRead();
				await expect(
					reads.readBatch(
						NATIVE_READ_CONTEXT,
						changesRequest(5, 4),
						emptyTicket,
					),
				).rejects.toMatchObject({ failure: { kind: "cursor_expired" } });
				await expect(
					reads.readBatch(
						NATIVE_READ_CONTEXT,
						changesRequest(5, 5),
						emptyTicket,
					),
				).resolves.toMatchObject({ collection: "changes", rows: [] });
			},
		);
	});

	it("returns current epoch when a valid ticket uses an old collection epoch", async () => {
		await withNativeReadFixture(async ({ reads, authorizeRead }) => {
			const ticket = await authorizeRead();
			await expect(
				reads.readBatch(
					NATIVE_READ_CONTEXT,
					{
						collection: "manifest",
						epoch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						head_seq: 0,
						after_path: null,
						limit: 64,
					},
					ticket,
				),
			).rejects.toMatchObject({
				failure: { kind: "epoch_mismatch", current_epoch: NATIVE_READ_EPOCH },
			});
		});
	});

	it("rejects future sequence cursors and captured heads", async () => {
		await withNativeReadFixture(async ({ reads, authorizeRead }) => {
			const ticket = await authorizeRead();
			await expect(
				reads.readBatch(NATIVE_READ_CONTEXT, changesRequest(0, 1), ticket),
			).rejects.toMatchObject({ failure: { kind: "invalid_request" } });
			await expect(
				reads.readBatch(
					NATIVE_READ_CONTEXT,
					{
						collection: "manifest",
						epoch: NATIVE_READ_EPOCH,
						head_seq: 1,
						after_path: null,
						limit: 64,
					},
					ticket,
				),
			).rejects.toMatchObject({ failure: { kind: "invalid_request" } });
		});
	});

	it("rejects tickets after expiry, revocation, and grant mismatch before returning rows", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				const ticket = await authorizeRead();
				const emptyManifest = {
					collection: "manifest" as const,
					epoch: NATIVE_READ_EPOCH,
					head_seq: 0,
					after_path: null,
					limit: 64,
				};
				const wrongGrant: AuthorizationContext = {
					...NATIVE_READ_CONTEXT,
					grant_id: "different-grant",
				};
				await expect(
					reads.readBatch(wrongGrant, emptyManifest, ticket),
				).rejects.toMatchObject({ failure: { kind: "invalid_ticket" } });
				storage.sql.exec(
					"INSERT INTO revoked_grants(grant_id,at) VALUES (?, 1)",
					NATIVE_READ_CONTEXT.grant_id,
				);
				await expect(
					reads.readBatch(NATIVE_READ_CONTEXT, emptyManifest, ticket),
				).rejects.toMatchObject({ failure: { kind: "revoked" } });
				storage.sql.exec("DELETE FROM revoked_grants");
				setNow(1_000_061_000);
				await expect(
					reads.readBatch(NATIVE_READ_CONTEXT, emptyManifest, ticket),
				).rejects.toMatchObject({ failure: { kind: "invalid_ticket" } });
			},
		);
	});

	it("keeps retained and export-pinned history rows available past age cutoff", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow, queries }) => {
				const now = 40 * day;
				setNow(now);
				const path = "files/pinned-history.md";
				storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 2, 2, ?, 1, 'text', 'new', 0, ?, 'seed')",
					path,
					pathKey(path),
					"b".repeat(64),
					now,
				);
				storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 1, 'text', 'old', 0, 'seed', ?), (?, 2, ?, 1, 'text', 'new', 0, 'seed', ?)",
					path,
					"a".repeat(64),
					now - 40 * day,
					path,
					"b".repeat(64),
					now,
				);
				storage.sql.exec(
					"INSERT INTO export_pins(export_id,path,rev) VALUES ('export-1', ?, 1)",
					path,
				);
				storage.sql.exec("UPDATE meta SET value = '2' WHERE key = 'head_seq'");
				const ticket = await authorizeRead(NATIVE_READ_CONTEXT, [path]);
				const upper = await reads.readHistoryUpper(
					NATIVE_READ_CONTEXT,
					ticket,
					path,
				);
				if (upper.upper_etag === null)
					throw new Error("History row was not seeded");
				const page = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					{
						collection: "history",
						epoch: upper.epoch,
						path,
						upper_etag: upper.upper_etag,
						after_rev: null,
						limit: 64,
					},
					ticket,
				);
				expect(page).toMatchObject({
					collection: "history",
					rows: [{ rev: 1 }, { rev: 2 }],
				});
				expect(
					queries.every((query) => !/\b(content|blob_hash)\b/i.test(query)),
				).toBe(true);
			},
		);
	});

	it("retains an uncertain read to its original deadline and settles only its owner", async () => {
		await withNativeReadFixture(
			async ({ storage, admissions, authorizeRead, setNow }) => {
				const uncertainTicket = await authorizeRead();
				const deadline = storage.sql
					.exec(
						"SELECT expires_at FROM operation_admissions WHERE id = ?",
						uncertainTicket,
					)
					.toArray()[0]?.expires_at;
				setNow(1_000_001_000);
				expect(
					admissions.finish(NATIVE_READ_CONTEXT, uncertainTicket, "uncertain"),
				).toEqual({ ok: true });
				expect(
					storage.sql
						.exec(
							"SELECT expires_at,state FROM operation_admissions WHERE id = ?",
							uncertainTicket,
						)
						.toArray(),
				).toEqual([{ expires_at: deadline, state: "uncertain" }]);
				const settledTicket = await authorizeRead();
				storage.sql.exec(
					"INSERT INTO operation_admissions(id,client_id,grant_id,epoch,fingerprint,admitted_at,expires_at,state) VALUES ('ffffffffffffffffffffffffffffffff','other-client','other-grant',?,'other-fingerprint',1,50000,'uncertain')",
					NATIVE_READ_EPOCH,
				);
				expect(
					admissions.finish(NATIVE_READ_CONTEXT, settledTicket, "settled"),
				).toEqual({ ok: true });
				expect(
					storage.sql
						.exec(
							"SELECT id FROM operation_admissions WHERE id = 'ffffffffffffffffffffffffffffffff'",
						)
						.toArray(),
				).toHaveLength(1);
			},
		);
	});

	it("orders BMP and supplementary Unicode paths by SQLite BINARY bytes", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, queries }) => {
				const bmp = "\uE000.md";
				const supplementary = "\u{10000}.md";
				for (const [index, path] of [supplementary, bmp].entries()) {
					storage.sql.exec(
						"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 1, 'text', 'x', 0, 1, 'seed')",
						path,
						pathKey(path),
						index + 1,
						"a".repeat(64),
					);
				}
				storage.sql.exec("UPDATE meta SET value = '2' WHERE key = 'head_seq'");
				const ticket = await authorizeRead();
				const batch = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					{
						collection: "manifest",
						epoch: NATIVE_READ_EPOCH,
						head_seq: 2,
						after_path: null,
						limit: 64,
					},
					ticket,
				);
				expect(batch).toMatchObject({
					collection: "manifest",
					rows: [{ path: bmp }, { path: supplementary }],
				});
				const projections = queries.filter((query) =>
					/\bselect\b/i.test(query),
				);
				expect(projections.length).toBeGreaterThan(0);
				expect(
					projections.every((query) => !/\b(content|blob_hash)\b/i.test(query)),
				).toBe(true);
			},
		);
	});

	it("keeps a write behind the path seek visible to a later feed head", async () => {
		await withNativeReadFixture(async ({ storage, reads, authorizeRead }) => {
			for (const [seq, path] of [
				[1, "files/000.md"],
				[2, "files/999.md"],
			] as const) {
				storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 1, 'text', 'x', 0, 1, 'seed')",
					path,
					pathKey(path),
					seq,
					"a".repeat(64),
				);
				seedReadChange(storage, { seq, at: 40 * day, path });
			}
			storage.sql.exec("UPDATE meta SET value = '2' WHERE key = 'head_seq'");
			const ticket = await authorizeRead();
			const first = await reads.readBatch(
				NATIVE_READ_CONTEXT,
				{
					collection: "manifest",
					epoch: NATIVE_READ_EPOCH,
					head_seq: 2,
					after_path: null,
					limit: 1,
				},
				ticket,
			);
			expect(first).toMatchObject({
				collection: "manifest",
				rows: [{ path: "files/000.md" }, { path: "files/999.md" }],
			});
			storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 3, ?, 1, 'text', 'x', 0, 1, 'seed')",
				"files/100.md",
				pathKey("files/100.md"),
				"b".repeat(64),
			);
			seedReadChange(storage, { seq: 3, at: 40 * day, path: "files/100.md" });
			storage.sql.exec("UPDATE meta SET value = '3' WHERE key = 'head_seq'");
			const next = await reads.readBatch(
				NATIVE_READ_CONTEXT,
				{
					collection: "manifest",
					epoch: NATIVE_READ_EPOCH,
					head_seq: 2,
					after_path: "files/000.md",
					limit: 1,
				},
				ticket,
			);
			expect(next).toMatchObject({
				collection: "manifest",
				rows: [
					{ path: "files/100.md", seq: 3 },
					{ path: "files/999.md", seq: 2 },
				],
			});
			const nextFeed = await reads.readBatch(
				NATIVE_READ_CONTEXT,
				changesRequest(3, 2),
				ticket,
			);
			expect(nextFeed).toMatchObject({
				collection: "changes",
				rows: [{ seq: 3, path: "files/100.md" }],
			});
		});
	});

	it("reads PUT, delete, recreate, append, restore, and rename as immutable feed operations", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				setNow(40 * day);
				seedReadChange(storage, {
					seq: 1,
					at: 40 * day,
					op: "put",
					rev: 1,
					path: "files/note.md",
				});
				seedReadChange(storage, {
					seq: 2,
					at: 40 * day,
					op: "delete",
					rev: 2,
					path: "files/note.md",
					hash: "",
				});
				seedReadChange(storage, {
					seq: 3,
					at: 40 * day,
					op: "put",
					rev: 3,
					path: "files/note.md",
				});
				seedReadChange(storage, {
					seq: 4,
					at: 40 * day,
					op: "put",
					rev: 4,
					path: "files/note.md",
				});
				seedReadChange(storage, {
					seq: 5,
					at: 40 * day,
					op: "put",
					rev: 5,
					path: "files/note.md",
				});
				seedReadChange(storage, {
					seq: 6,
					at: 40 * day,
					op: "rename",
					rev: 1,
					path: "files/renamed.md",
					fromPath: "files/note.md",
					fromRev: 6,
				});
				storage.sql.exec("UPDATE meta SET value = '6' WHERE key = 'head_seq'");
				const ticket = await authorizeRead();
				const feed = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					changesRequest(6, 0),
					ticket,
				);
				expect(feed).toMatchObject({
					collection: "changes",
					rows: [
						{ seq: 1, op: "put" },
						{ seq: 2, op: "delete", hash: "" },
						{ seq: 3, op: "put" },
						{ seq: 4, op: "put" },
						{ seq: 5, op: "put" },
						{ seq: 6, op: "rename", from_path: "files/note.md" },
					],
				});
			},
		);
	});

	it("keeps retained feed and rename ETags stable after current rows change and revisions prune", async () => {
		await withNativeReadFixture(
			async ({ storage, reads, authorizeRead, setNow }) => {
				setNow(40 * day);
				const source = "files/source.md";
				const destination = "files/destination.md";
				for (const path of [source, destination]) {
					storage.sql.exec(
						"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, 1, 'text', 'x', 0, 1, 'seed')",
						path,
						pathKey(path),
						"a".repeat(64),
					);
					storage.sql.exec(
						"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 1, 'text', 'x', 0, 'seed', 1)",
						path,
						"a".repeat(64),
					);
				}
				seedReadChange(storage, {
					seq: 1,
					at: 40 * day,
					path: destination,
					rev: 1,
					hash: "b".repeat(64),
					op: "rename",
					fromPath: source,
					fromRev: 2,
				});
				storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'head_seq'");
				const ticket = await authorizeRead();
				const request = changesRequest(1, 0);
				const before = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					request,
					ticket,
				);
				storage.sql.exec(
					"UPDATE files SET rev = 8, hash = ? WHERE path IN (?, ?)",
					"c".repeat(64),
					source,
					destination,
				);
				storage.sql.exec("DELETE FROM revisions");
				const after = await reads.readBatch(
					NATIVE_READ_CONTEXT,
					request,
					ticket,
				);
				expect(after).toEqual(before);
				expect(after).toMatchObject({
					collection: "changes",
					rows: [
						{
							op: "rename",
							etag: formatETag(NATIVE_READ_EPOCH, 1),
							from_etag: formatETag(NATIVE_READ_EPOCH, 2),
						},
					],
				});
			},
		);
	});

	it("rechecks revocation between native batches and denies write-only admission", async () => {
		await withNativeReadFixture(async ({ storage, reads, authorizeRead }) => {
			const ticket = await authorizeRead();
			const request = {
				collection: "manifest" as const,
				epoch: NATIVE_READ_EPOCH,
				head_seq: 0,
				after_path: null,
				limit: 64,
			};
			await expect(
				reads.readBatch(NATIVE_READ_CONTEXT, request, ticket),
			).resolves.toEqual({ collection: "manifest", rows: [] });
			storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id,at) VALUES (?, 1)",
				NATIVE_READ_CONTEXT.grant_id,
			);
			await expect(
				reads.readBatch(NATIVE_READ_CONTEXT, request, ticket),
			).rejects.toMatchObject({ failure: { kind: "revoked" } });
			const writeOnly: AuthorizationContext = {
				...NATIVE_READ_CONTEXT,
				client_id: "write-only",
				grant_id: "write-only-grant",
				scopes: ["vault:write"],
			};
			await expect(authorizeRead(writeOnly)).rejects.toThrow(
				"Read authorization failed: forbidden_scope",
			);
			expect(
				storage.sql
					.exec(
						"SELECT id FROM operation_admissions WHERE client_id = 'write-only'",
					)
					.toArray(),
			).toEqual([]);
		});
	});
});
