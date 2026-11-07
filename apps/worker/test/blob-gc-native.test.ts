import { SqliteBlobGcStore } from "@worker/infrastructure/sqlite/blob-gc";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { withTextStore } from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

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

			expect(await gc.marked()).toEqual([{ hash: orphan, size: 11 }]);
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
			await gc.mark([candidate]);
			await gc.mark([candidate]);
			expect(await gc.marked()).toEqual([candidate]);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			await gc.clear([candidate]);
			await gc.clear([candidate]);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "2" }]);
		});
	});
});
