import { BlobGcService } from "@worker/application/blob-gc";
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
	it("rejects delayed inventory after another caller completes the run", async () => {
		await withTextStore(async ({ storage }) => {
			const repository = new SqliteBlobGcStore(storage);
			const candidate = { hash: "f".repeat(64), size: 23 };
			await repository.start();
			/** Release the delayed page after another caller completes its run. */
			let resolveDelayedPage: (page: {
				objects: (typeof candidate)[];
				cursor: string | null;
			}) => void = () => undefined;
			const delayedPage = new Promise<{
				objects: (typeof candidate)[];
				cursor: string | null;
			}>((resolve) => {
				resolveDelayedPage = resolve;
			});
			const delayedStore = {
				list: vi.fn(async () => delayedPage),
				delete: vi.fn(async () => undefined),
			};
			const delayedRun = new BlobGcService(
				repository,
				delayedStore,
			).collectBatch();
			try {
				await vi.waitFor(() =>
					expect(delayedStore.list).toHaveBeenCalledOnce(),
				);
				const fastStore = {
					list: vi.fn(async () => ({ objects: [candidate], cursor: null })),
					delete: vi.fn(async () => undefined),
				};
				const fastService = new BlobGcService(repository, fastStore);
				await fastService.collectBatch();
				await fastService.collectBatch();
				await fastService.collectBatch();
				expect(await repository.status()).toMatchObject({
					phase: "idle",
					marked_count: 0,
				});

				resolveDelayedPage({ objects: [candidate], cursor: null });
				await delayedRun;
				expect(await repository.status()).toMatchObject({
					phase: "idle",
					marked_count: 0,
				});
			} finally {
				resolveDelayedPage({ objects: [candidate], cursor: null });
				await Promise.allSettled([delayedRun]);
			}
		});
	});

	it("rejects old inventory when a newer run reuses the initial cursor", async () => {
		await withTextStore(async ({ storage }) => {
			const repository = new SqliteBlobGcStore(storage);
			const candidate = { hash: "e".repeat(64), size: 29 };
			await repository.start();
			/** Release the old page after the newer run starts at the same cursor. */
			let resolveDelayedPage: (page: {
				objects: (typeof candidate)[];
				cursor: string | null;
			}) => void = () => undefined;
			const delayedPage = new Promise<{
				objects: (typeof candidate)[];
				cursor: string | null;
			}>((resolve) => {
				resolveDelayedPage = resolve;
			});
			const delayedStore = {
				list: vi.fn(async () => delayedPage),
				delete: vi.fn(async () => undefined),
			};
			const delayedRun = new BlobGcService(
				repository,
				delayedStore,
			).collectBatch();
			try {
				await vi.waitFor(() =>
					expect(delayedStore.list).toHaveBeenCalledOnce(),
				);
				const fastStore = {
					list: vi.fn(async () => ({ objects: [candidate], cursor: null })),
					delete: vi.fn(async () => undefined),
				};
				const fastService = new BlobGcService(repository, fastStore);
				await fastService.collectBatch();
				await fastService.collectBatch();
				await fastService.collectBatch();
				await repository.start();
				expect(await repository.runState()).toMatchObject({
					phase: "marking",
					cursor: null,
				});

				resolveDelayedPage({ objects: [candidate], cursor: null });
				await delayedRun;
				expect(await repository.runState()).toMatchObject({
					phase: "marking",
					cursor: null,
				});
				expect(await repository.status()).toMatchObject({ marked_count: 0 });
			} finally {
				resolveDelayedPage({ objects: [candidate], cursor: null });
				await Promise.allSettled([delayedRun]);
			}
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
			await gc.start();
			const state = await gc.runState();
			if (state.runId === null)
				throw new Error("GC start did not assign a run identity");
			await gc.recordInventoryFailure(state.runId, state.cursor);
			expect(await gc.status()).toMatchObject({
				failure: "blob_gc_unavailable",
			});
			await gc.markAndAdvance(
				state.runId,
				state.cursor,
				[
					{ hash: retained, size: 7 },
					{ hash: orphan, size: 11 },
				],
				null,
			);
			expect(await gc.status()).toMatchObject({ failure: null });

			expect(
				storage.sql.exec("SELECT hash, size FROM blob_gc").toArray(),
			).toEqual([{ hash: orphan, size: 11 }]);
		});
	});

	it("bounds duplicate revision and export reachability results to candidate hashes", async () => {
		await withTextStore(async ({ storage }) => {
			const hashes = ["1".repeat(64), "2".repeat(64)];
			storage.sql.exec(
				"INSERT INTO packed_exports(id,epoch,created_at,head_seq,status,object_key,started_at,zip_state,manifest_size,completed_parts) VALUES ('export-many','0123456789abcdef0123456789abcdef','2026-01-01T00:00:00.000Z',1,'uploading','backups/many.zip',1,'{}',0,'[]')",
			);
			for (let index = 0; index < 160; index += 1) {
				const hash = hashes[index % hashes.length];
				storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,blob_hash,deleted,origin,at) VALUES (?,1,?,7,'blob',?,0,'fixture',1)",
					`retained-${index}.pdf`,
					hash,
					hash,
				);
				storage.sql.exec(
					"INSERT INTO packed_export_files(export_id,ordinal,path,rev,hash,size,source_type) VALUES ('export-many',?,?,1,?,7,'snapshot_blob')",
					index,
					`export-${index}.pdf`,
					hash,
				);
			}
			expect(
				storage.sql.exec("SELECT count(*) AS count FROM revisions").toArray(),
			).toEqual([{ count: 160 }]);
			expect(
				storage.sql
					.exec("SELECT count(*) AS count FROM packed_export_files")
					.toArray(),
			).toEqual([{ count: 160 }]);
			const bindingCounts: number[] = [];
			const revisionResultSizes: number[] = [];
			const exportResultSizes: number[] = [];
			const originalExec = storage.sql.exec.bind(storage.sql);
			vi.spyOn(storage.sql, "exec").mockImplementation((query, ...bindings) => {
				bindingCounts.push(bindings.length);
				const cursor = originalExec(query, ...bindings);
				const originalRaw = cursor.raw.bind(cursor);
				vi.spyOn(cursor, "raw").mockImplementation(() => {
					const rawResult = originalRaw();
					const rawCursor = rawResult as IterableIterator<unknown> & {
						/** Return raw rows so the test can measure result cardinality. */
						toArray(): unknown[];
					};
					const originalToArray = rawCursor.toArray.bind(rawCursor);
					vi.spyOn(rawCursor, "toArray").mockImplementation(() => {
						const rows = originalToArray();
						if (query.includes("revisions"))
							revisionResultSizes.push(rows.length);
						if (query.includes("packed_export_files"))
							exportResultSizes.push(rows.length);
						return rows;
					});
					return rawResult;
				});
				return cursor;
			});
			const gc = new SqliteBlobGcStore(storage);
			const candidates = hashes.map((hash) => ({ hash, size: 7 }));

			expect(await gc.preview(candidates)).toEqual({ count: 0, bytes: 0 });
			expect(revisionResultSizes).toEqual([candidates.length]);
			expect(exportResultSizes).toEqual([candidates.length]);
			expect(
				Math.max(...revisionResultSizes, ...exportResultSizes),
			).toBeLessThanOrEqual(candidates.length);
			expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100);
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
			await gc.start();
			const state = await gc.runState();
			if (state.runId === null)
				throw new Error("GC start did not assign a run identity");

			expect(
				await gc.markAndAdvance(state.runId, state.cursor, candidates, null),
			).toBe(true);
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
			const runState = await gc.runState();
			if (runState.runId === null)
				throw new Error("GC start did not assign a run identity");
			expect(
				await gc.markAndAdvance(
					runState.runId,
					runState.cursor,
					[candidate],
					null,
				),
			).toBe(true);

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
			expect(await restarted.status()).toMatchObject({
				delete_state: "idle",
				failure: null,
				marked_count: 0,
			});
			expect(await restarted.claimDeleteBatch(owner)).toEqual([]);
			await restarted.finish(owner);
			expect(await restarted.status()).toMatchObject({
				phase: "idle",
				delete_state: "idle",
				marked_count: 0,
			});
			expect(await restarted.runState()).toMatchObject({
				runId: null,
				phase: "idle",
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
			const run = await gc.runState();
			if (run.runId === null)
				throw new Error("GC start did not assign a run identity");
			expect(
				await gc.markAndAdvance(
					run.runId,
					run.cursor,
					[candidate],
					"next-page",
				),
			).toBe(true);
			expect(
				await gc.markAndAdvance(run.runId, "next-page", [candidate], null),
			).toBe(true);
			expect(
				storage.sql.exec("SELECT hash, size FROM blob_gc").toArray(),
			).toEqual([candidate]);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key='blob_gc_generation'")
					.toArray(),
			).toEqual([{ value: "1" }]);
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
