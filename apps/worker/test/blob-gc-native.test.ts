import { SqliteBlobGcStore } from "@worker/infrastructure/sqlite/blob-gc";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { withTextStore } from "@worker/test-fixtures/text-files";
import { describe, expect, it, vi } from "vitest";

describe("native blob-GC authority", () => {
	it("upgrades an exact schema-8 store without changing its epoch", async () => {
		await withTextStore(async ({ storage }) => {
			const epoch = storage.sql
				.exec("SELECT value FROM meta WHERE key='epoch'")
				.toArray()[0]?.value;
			storage.sql.exec("DROP TABLE blob_gc");
			storage.sql.exec("DELETE FROM meta WHERE key LIKE 'blob_gc_%'");
			storage.sql.exec("UPDATE meta SET value='8' WHERE key='schema_version'");

			initializeVaultStorage(
				storage,
				() => {
					throw new Error("schema upgrade must preserve the epoch");
				},
				() => {
					throw new Error("schema upgrade must preserve creation time");
				},
			);

			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='schema_version'")
					.toArray(),
			).toEqual([{ value: "9" }]);
			expect(
				storage.sql.exec("SELECT value FROM meta WHERE key='epoch'").toArray(),
			).toEqual([{ value: epoch }]);
			expect(
				storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name='blob_gc'")
					.toArray(),
			).toEqual([{ name: "blob_gc" }]);
		});
	});
	it("protects retained revision references and marks only true orphans", async () => {
		await withTextStore(async ({ storage }) => {
			const gc = new SqliteBlobGcStore(storage);
			const retained = "a".repeat(64);
			const orphan = "b".repeat(64);
			storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,blob_hash,deleted,origin,at) VALUES ('old.pdf',1,?,7,'blob',?,0,'fixture',1)",
				retained,
				retained,
			);

			expect(
				await gc.preview([
					{ hash: retained, size: 7 },
					{ hash: orphan, size: 11 },
				]),
			).toEqual({ count: 1, bytes: 11 });
			await gc.mark([
				{ hash: retained, size: 7 },
				{ hash: orphan, size: 11 },
			]);

			expect(
				storage.sql.exec("SELECT hash, size FROM blob_gc").toArray(),
			).toEqual([{ hash: orphan, size: 11 }]);
		});
	});

	it("keeps preview and mark reference queries within the 100-binding limit", async () => {
		await withTextStore(async ({ storage }) => {
			const bindingCounts: number[] = [];
			const originalExec = storage.sql.exec.bind(storage.sql);
			vi.spyOn(storage.sql, "exec").mockImplementation((query, ...bindings) => {
				bindingCounts.push(bindings.length);
				return originalExec(query, ...bindings);
			});
			const gc = new SqliteBlobGcStore(storage);
			const candidates = Array.from({ length: 100 }, (_, index) => ({
				hash: index.toString(16).padStart(64, "0"),
				size: index,
			}));

			expect(await gc.preview(candidates)).toEqual({
				count: 100,
				bytes: 4_950,
			});
			expect(bindingCounts.length).toBeGreaterThan(0);
			expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100);
			bindingCounts.length = 0;

			await gc.mark(candidates);
			expect(bindingCounts.length).toBeGreaterThan(0);
			expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100);
			expect(
				storage.sql.exec("SELECT count(*) AS count FROM blob_gc").toArray(),
			).toEqual([{ count: 100 }]);
		});
	});

	it("keeps delete ownership durable until settlement and permits a settled retry", async () => {
		await withTextStore(async ({ storage }) => {
			const owner = "11111111-1111-4111-8111-111111111111";
			const retryOwner = "22222222-2222-4222-8222-222222222222";
			const candidate = { hash: "c".repeat(64), size: 19 };
			const gc = new SqliteBlobGcStore(storage);
			await gc.start();
			await gc.mark([candidate]);
			await gc.advance(null);

			expect(await gc.claimDeleteBatch(owner)).toEqual([candidate]);
			const restarted = new SqliteBlobGcStore(storage);
			restarted.markInterruptedDeleteUnknown();
			expect(await restarted.claimDeleteBatch(retryOwner)).toBeNull();
			expect(await restarted.status()).toMatchObject({
				phase: "deleting",
				delete_state: "unknown",
				marked_count: 1,
			});

			await restarted.recordFailure(owner);
			expect(await restarted.status()).toMatchObject({
				delete_state: "idle",
				failure: "blob_gc_unavailable",
				marked_count: 1,
			});
			expect(await restarted.claimDeleteBatch(retryOwner)).toEqual([candidate]);
			await restarted.clear([candidate], retryOwner);
			expect(await restarted.claimDeleteBatch(owner)).toEqual([]);
			await restarted.finish(owner);
			expect(await restarted.status()).toMatchObject({
				phase: "idle",
				delete_state: "idle",
				marked_count: 0,
			});
		});
	});

	it("protects active packed-export blob sources that are absent from blob_refs", async () => {
		await withTextStore(async ({ storage }) => {
			const gc = new SqliteBlobGcStore(storage);
			const source = "c".repeat(64);
			storage.sql.exec(
				"INSERT INTO packed_exports(id,epoch,created_at,head_seq,status,object_key,started_at,zip_state,manifest_size,completed_parts) VALUES ('export-1','0123456789abcdef0123456789abcdef','2026-01-01T00:00:00.000Z',1,'uploading','backups/test.zip',1,'{}',0,'[]')",
			);
			storage.sql.exec(
				"INSERT INTO packed_export_files(export_id,ordinal,path,rev,hash,size,source_type) VALUES ('export-1',0,'file.pdf',1,?,19,'snapshot_blob')",
				source,
			);

			expect(await gc.preview([{ hash: source, size: 19 }])).toEqual({
				count: 0,
				bytes: 0,
			});
		});
	});

	it("changes the publication generation when marks are added and cleared", async () => {
		await withTextStore(async ({ storage }) => {
			const gc = new SqliteBlobGcStore(storage);
			const candidate = { hash: "d".repeat(64), size: 23 };

			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "0" }]);
			await gc.start();
			await gc.mark([candidate]);
			await gc.mark([candidate]);
			expect(
				storage.sql.exec("SELECT hash, size FROM blob_gc").toArray(),
			).toEqual([candidate]);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			await gc.advance(null);
			const owner = "33333333-3333-4333-8333-333333333333";
			expect(await gc.claimDeleteBatch(owner)).toEqual([candidate]);
			await gc.clear([candidate], owner);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "2" }]);
		});
	});
});
