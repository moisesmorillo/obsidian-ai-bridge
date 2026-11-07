import { env, runInDurableObject } from "cloudflare:test";
import type { BlobContentStore } from "@worker/application/blobs";
import {
	PackedExportSourceFailure,
	PackedExportStorageFailure,
} from "@worker/application/export";
import { FileOperationDenied } from "@worker/application/files";
import { SqlitePackedExportStore } from "@worker/infrastructure/sqlite/packed-exports";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { describe, expect, it } from "vitest";

const exportCreatedAt = "2026-11-07T03:00:00.000Z";

/** Return a lowercase SHA-256 digest for the immutable text fixture. */
async function hashExportText(value: string): Promise<string> {
	return hashExportBytes(new TextEncoder().encode(value));
}

/** Return a lowercase SHA-256 digest for one immutable byte fixture. */
async function hashExportBytes(value: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		value.slice().buffer as ArrayBuffer,
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Insert one live text revision into an initialized test vault. */
function seedExportText(
	storage: DurableObjectStorage,
	path: string,
	rev: number,
	value: string,
	hash: string,
): void {
	const size = new TextEncoder().encode(value).byteLength;
	storage.sql.exec(
		"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'text', ?, NULL, NULL, 0, 1, 'test')",
		path,
		path.toLowerCase(),
		rev,
		rev,
		hash,
		size,
		value,
	);
	storage.sql.exec(
		"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES (?, ?, ?, ?, 'text', ?, NULL, 0, 'test', 1)",
		path,
		rev,
		hash,
		size,
		value,
	);
}

/** Provide a blob capability that rejects use in this text-only test. */
function noExportBlobReads(): BlobContentStore {
	return {
		/** Report no test blobs without reading storage. */
		async head() {
			return undefined;
		},
		/** Reject mutations because this test owns no blob-write setup. */
		async putVerified() {
			throw new Error("Unexpected blob write");
		},
		/** Reject blob access because this fixture contains only inline text. */
		async read() {
			throw new Error("Unexpected blob read");
		},
	};
}

describe("schema-7 packed-export upgrade", () => {
	it("adds export checkpoints and entry pins without changing vault identity", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-upgrade-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const storage = state.storage;
			const epochBefore = storage.sql
				.exec("SELECT value FROM meta WHERE key = 'epoch'")
				.toArray()[0]?.value;
			storage.sql.exec("DROP TABLE IF EXISTS packed_export_files");
			storage.sql.exec("DROP TABLE IF EXISTS packed_exports");
			storage.sql.exec(
				"UPDATE meta SET value = '7' WHERE key = 'schema_version'",
			);
			initializeVaultStorage(
				storage,
				() => {
					throw new Error("migration must preserve the vault epoch");
				},
				() => {
					throw new Error("migration must preserve creation time");
				},
			);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'schema_version'")
					.toArray()[0]?.value,
			).toBe("8");
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'epoch'")
					.toArray()[0]?.value,
			).toBe(epochBefore);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name IN ('packed_exports', 'packed_export_files') ORDER BY name",
					)
					.toArray(),
			).toEqual([{ name: "packed_export_files" }, { name: "packed_exports" }]);
		});
	});
});

describe("SQLite packed export store", () => {
	it("pins one immutable cut and rejects stale checkpoint writes", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-store-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			initializeVaultStorage(
				state.storage,
				() => "a".repeat(32),
				() => 1,
			);
			const before = "first 🌳\\n";
			const after = "second text\\n";
			const beforeHash = await hashExportText(before);
			const afterHash = await hashExportText(after);
			seedExportText(state.storage, "notes/a.md", 1, before, beforeHash);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'live_file_count'",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'head_seq'",
			);
			const store = new SqlitePackedExportStore(
				state.storage,
				noExportBlobReads(),
			);
			const captured = await store.capture(exportCreatedAt, 100);
			expect(captured.status).toBe("queued");
			expect(captured.files.map(({ rev }) => rev)).toEqual([1]);
			expect(
				state.storage.sql
					.exec("SELECT rev FROM export_pins WHERE export_id = ?", captured.id)
					.toArray(),
			).toEqual([{ rev: 1 }]);

			state.storage.sql.exec("DELETE FROM files WHERE path = ?", "notes/a.md");
			seedExportText(state.storage, "notes/a.md", 2, after, afterHash);
			const oldBytes = new TextEncoder().encode(before);
			expect(
				await store.readSourceRange(captured.id, 0, 0, oldBytes.byteLength),
			).toEqual(oldBytes);
			expect((await store.capture(exportCreatedAt, 200)).startedAt).toBe(100);

			const next = {
				zipState: "cursor-one",
				pendingPart: new Uint8Array([1]),
				completedParts: [],
			};
			expect(await store.checkpoint(captured.id, "", next)).toBe(true);
			expect(await store.checkpoint(captured.id, "", next)).toBe(false);
			await store.fail(captured.id, "", { kind: "export_source_unavailable" });
			expect(
				state.storage.sql
					.exec("SELECT rev FROM export_pins WHERE export_id = ?", captured.id)
					.toArray(),
			).toEqual([{ rev: 1 }]);
			await store.fail(captured.id, "cursor-one", {
				kind: "export_source_unavailable",
			});
			expect((await store.capture(exportCreatedAt, 300)).failure?.kind).toBe(
				"export_source_unavailable",
			);
			expect(
				state.storage.sql
					.exec("SELECT * FROM export_pins WHERE export_id = ?", captured.id)
					.toArray(),
			).toEqual([]);
			expect((await store.nextActive())?.status ?? null).toBeNull();
		});
	});

	it("reads the pinned blob revision by its exact R2 byte range", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-blob-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			initializeVaultStorage(
				state.storage,
				() => "c".repeat(32),
				() => 1,
			);
			const bytes = new Uint8Array([0, 9, 255, 14, 6]);
			const hash = await hashExportBytes(bytes);
			state.storage.sql.exec(
				"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('assets/x.bin', 'assets/x.bin', 1, 1, ?, ?, 'blob', NULL, ?, NULL, 0, 1, 'test')",
				hash,
				bytes.byteLength,
				hash,
			);
			state.storage.sql.exec(
				"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES ('assets/x.bin', 1, ?, ?, 'blob', NULL, ?, 0, 'test', 1)",
				hash,
				bytes.byteLength,
				hash,
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'live_file_count'",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'head_seq'",
			);
			const ranges: Array<{ start: number; end: number }> = [];
			const blobs: BlobContentStore = {
				/** Return the immutable metadata for the exact binary fixture. */
				async head() {
					return { hash, size: bytes.byteLength };
				},
				/** Reject mutations because the range fixture only supports reads. */
				async putVerified() {
					throw new Error("Unexpected blob write");
				},
				/** Return exactly the requested immutable blob range. */
				async read(_hash, _size, range) {
					if (!range) throw new Error("Expected a bounded blob range");
					ranges.push(range);
					return new ReadableStream<Uint8Array>({
						/** Emit only the selected test bytes. */
						start(controller) {
							controller.enqueue(bytes.slice(range.start, range.end + 1));
							controller.close();
						},
					});
				},
			};
			const store = new SqlitePackedExportStore(state.storage, blobs);
			const captured = await store.capture(exportCreatedAt, 10);
			expect(await store.readSourceRange(captured.id, 0, 1, 3)).toEqual(
				new Uint8Array([9, 255, 14]),
			);
			expect(ranges).toEqual([{ start: 1, end: 3 }]);
			blobs.read = async () => {
				throw new FileOperationDenied({
					kind: "blob_storage_unavailable",
					retry_after_seconds: 1,
				});
			};
			await expect(
				store.readSourceRange(captured.id, 0, 1, 3),
			).rejects.toBeInstanceOf(PackedExportStorageFailure);
			blobs.head = async () => undefined;
			await expect(
				store.readSourceRange(captured.id, 0, 1, 3),
			).rejects.toBeInstanceOf(PackedExportSourceFailure);
		});
	});
});

describe("packed export alarm dispatch", () => {
	it("continues queued work and exposes only the completed R2 object", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-alarm-${crypto.randomUUID()}`),
		);
		const result = await runInDurableObject(stub, async (instance, state) => {
			const started = await instance.startPackedExport(
				"synthetic-owner",
				"2026-11-07T03:00:00.000Z",
			);
			expect(started?.status).toBe("queued");
			const alarm = await state.storage.getAlarm();
			expect(alarm).not.toBeNull();
			await instance.alarm();
			const afterFirstStep =
				await instance.listPackedExports("synthetic-owner");
			expect(afterFirstStep).toEqual([]);
			await instance.alarm();
			const snapshots = await instance.listPackedExports("synthetic-owner");
			expect(snapshots?.[0]?.status).toBe("complete");
			if (!started) throw new Error("Owner export did not start");
			return started.epoch;
		});
		const archive = await stub.getPackedExportDownload(
			"synthetic-owner",
			result,
			"2026-11-07T03:00:00.000Z",
		);
		if (!archive) throw new Error("Completed export has no archive stream");
		const bytes = new Uint8Array(
			await new Response(archive.body).arrayBuffer(),
		);
		expect(bytes.byteLength).toBe(archive.size);
		expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
	});
});
