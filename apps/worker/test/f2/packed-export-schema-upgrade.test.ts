import { env, runInDurableObject } from "cloudflare:test";
import { ExportManifestSchema } from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import {
	PackedExportService,
	PackedExportSourceFailure,
	PackedExportStorageFailure,
} from "@worker/application/export";
import { FileOperationDenied } from "@worker/application/files";
import type { Env } from "@worker/env";
import { R2PackedArchiveStore } from "@worker/infrastructure/r2/packed-export";
import { revisionLogicalPayloadBytes } from "@worker/infrastructure/sqlite/capacity";
import { SqlitePackedExportStore } from "@worker/infrastructure/sqlite/packed-exports";
import { SqliteRetentionStore } from "@worker/infrastructure/sqlite/retention";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { unzipSync } from "fflate";
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
	revisionAt = 1,
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
		"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES (?, ?, ?, ?, 'text', ?, NULL, 0, 'test', ?)",
		path,
		rev,
		hash,
		size,
		value,
		revisionAt,
	);
}

/** Seed current text rows and retained revisions with one bounded recursive insert. */
function seedExportTextRows(
	storage: DurableObjectStorage,
	count: number,
): void {
	if (!Number.isSafeInteger(count) || count < 1 || count > 10_000)
		throw new Error("Invalid export text fixture count");
	const emptyHash =
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	storage.sql.exec(
		"WITH RECURSIVE sequence(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?), rows(path, ordinal) AS (SELECT printf('file-%05d.md', value), value + 1 FROM sequence) INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) SELECT path, lower(path), 1, ordinal, ?, 0, 'text', '', NULL, NULL, 0, 1, 'test' FROM rows",
		count,
		emptyHash,
	);
	storage.sql.exec(
		"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) SELECT path, rev, hash, size, kind, content, blob_hash, deleted, origin, 1 FROM files WHERE deleted = 0",
	);
	storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key IN ('live_file_count', 'head_seq')",
		String(count),
	);
}

/** Seed the product maximum of current text rows with valid 512-byte paths. */
function seedMaximumPathExportRows(storage: DurableObjectStorage): void {
	const count = 10_000;
	const emptyHash =
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	storage.sql.exec(
		"WITH RECURSIVE sequence(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?), rows(path, ordinal) AS (SELECT printf('%05d', value) || printf('%0507d', 0), value + 1 FROM sequence) INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) SELECT path, lower(path), 1, ordinal, ?, 0, 'text', '', NULL, NULL, 0, 1, 'test' FROM rows",
		count,
		emptyHash,
	);
	storage.sql.exec(
		"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) SELECT path, rev, hash, size, kind, content, blob_hash, deleted, origin, 1 FROM files WHERE deleted = 0",
	);
	storage.sql.exec(
		"UPDATE meta SET value = '10000' WHERE key IN ('live_file_count', 'head_seq')",
	);
}

/** Verify stored ZIP records, central-directory offsets, data descriptors, and CRC values. */
function verifyStoredZipStructure(
	archive: Uint8Array,
	members: Readonly<Record<string, Uint8Array>>,
): void {
	const view = new DataView(
		archive.buffer,
		archive.byteOffset,
		archive.byteLength,
	);
	const endOffset = archive.byteLength - 22;
	if (view.getUint32(endOffset, true) !== 0x0605_4b50)
		throw new Error("Missing ZIP end record");
	const count = view.getUint16(endOffset + 10, true);
	const directorySize = view.getUint32(endOffset + 12, true);
	const directoryOffset = view.getUint32(endOffset + 16, true);
	if (directoryOffset + directorySize !== endOffset)
		throw new Error(
			"ZIP central directory offsets do not match the end record",
		);
	let offset = directoryOffset;
	const decoder = new TextDecoder();
	for (let index = 0; index < count; index += 1) {
		if (view.getUint32(offset, true) !== 0x0201_4b50)
			throw new Error("Missing ZIP central-directory record");
		const crc = view.getUint32(offset + 16, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const size = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const name = decoder.decode(
			archive.subarray(offset + 46, offset + 46 + nameLength),
		);
		const expected = members[name];
		if (!expected) throw new Error(`Unexpected ZIP member: ${name}`);
		if (
			localOffset >= directoryOffset ||
			view.getUint32(localOffset, true) !== 0x0403_4b50
		)
			throw new Error(`Invalid local-header offset for ${name}`);
		const localNameLength = view.getUint16(localOffset + 26, true);
		const localExtraLength = view.getUint16(localOffset + 28, true);
		const localName = decoder.decode(
			archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
		);
		if (
			localName !== name ||
			compressedSize !== expected.byteLength ||
			size !== expected.byteLength
		)
			throw new Error(`ZIP member metadata differs for ${name}`);
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
		const descriptorOffset = dataOffset + compressedSize;
		if (
			view.getUint32(descriptorOffset, true) !== 0x0807_4b50 ||
			view.getUint32(descriptorOffset + 4, true) !== crc ||
			view.getUint32(descriptorOffset + 8, true) !== size ||
			view.getUint32(descriptorOffset + 12, true) !== size ||
			crc32ForTest(expected) !== crc
		)
			throw new Error(`ZIP CRC or data descriptor differs for ${name}`);
		offset += 46 + nameLength + extraLength + commentLength;
	}
	if (offset !== directoryOffset + directorySize)
		throw new Error("ZIP central-directory size differs from its records");
	if (Object.keys(members).length !== count)
		throw new Error("ZIP member count differs from extracted files");
}

/** Calculate standard CRC-32 independently of the production ZIP encoder. */
function crc32ForTest(bytes: Uint8Array): number {
	let crc = 0xffff_ffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
	}
	return (crc ^ 0xffff_ffff) >>> 0;
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
			storage.sql.exec("DROP TABLE IF EXISTS blob_gc");
			storage.sql.exec("DELETE FROM meta WHERE key LIKE 'blob_gc_%'");
			storage.sql.exec("DROP TABLE IF EXISTS packed_export_chunks");
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
			).toBe("9");
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'epoch'")
					.toArray()[0]?.value,
			).toBe(epochBefore);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name IN ('blob_gc', 'packed_export_chunks', 'packed_exports', 'packed_export_files') ORDER BY name",
					)
					.toArray(),
			).toEqual([
				{ name: "blob_gc" },
				{ name: "packed_export_chunks" },
				{ name: "packed_export_files" },
				{ name: "packed_exports" },
			]);
		});
	});
});

describe("packed export after retention", () => {
	it.each(["ordinary_revisions", "pressure_revisions"] as const)(
		"captures an authoritative current file after %s pruning and freezes its bytes",
		async (category) => {
			const stub = env.VAULTS.get(
				env.VAULTS.idFromName(
					`packed-export-pruned-${category}-${crypto.randomUUID()}`,
				),
			);
			await runInDurableObject(stub, async (_instance, state) => {
				initializeVaultStorage(
					state.storage,
					() => "e".repeat(32),
					() => 1,
				);
				const before = "live bytes retained after pruning 🌳\\n";
				const after = "new current bytes after export\\n";
				const beforeHash = await hashExportText(before);
				const afterHash = await hashExportText(after);
				const now = 40 * 24 * 60 * 60 * 1000;
				const revisionAt =
					now -
					(category === "ordinary_revisions" ? 31 : 8) * 24 * 60 * 60 * 1000;
				seedExportText(
					state.storage,
					"notes/pruned.md",
					1,
					before,
					beforeHash,
					revisionAt,
				);
				state.storage.sql.exec(
					"UPDATE meta SET value = '1' WHERE key IN ('live_file_count', 'head_seq')",
				);
				const revisionBytes = revisionLogicalPayloadBytes({
					path: "notes/pruned.md",
					rev: 1,
					hash: beforeHash,
					size: new TextEncoder().encode(before).byteLength,
					kind: "text",
					content: before,
					blobHash: null,
					deleted: 0,
					origin: "test",
					at: revisionAt,
				});
				state.storage.sql.exec(
					"UPDATE meta SET value = ? WHERE key IN ('history_revisions_bytes', 'history_pressure_bytes')",
					String(revisionBytes),
				);
				const retention = new SqliteRetentionStore(
					state.storage,
					category === "pressure_revisions"
						? { historyPressureLimitBytes: revisionBytes - 1 }
						: undefined,
				);
				retention.runBatch(now);
				expect(
					state.storage.sql
						.exec(
							"SELECT 1 FROM revisions WHERE path = ? AND rev = 1",
							"notes/pruned.md",
						)
						.toArray(),
				).toEqual([]);

				const store = new SqlitePackedExportStore(
					state.storage,
					noExportBlobReads(),
				);
				const captured = await store.capture(exportCreatedAt, now);
				state.storage.sql.exec(
					"UPDATE files SET rev = 2, seq = 2, hash = ?, size = ?, content = ?, updated_at = 2 WHERE path = ?",
					afterHash,
					new TextEncoder().encode(after).byteLength,
					after,
					"notes/pruned.md",
				);
				expect(
					await store.readSourceRange(
						captured.id,
						0,
						0,
						new TextEncoder().encode(before).byteLength,
					),
				).toEqual(new TextEncoder().encode(before));
				expect(
					state.storage.sql
						.exec(
							"SELECT rev FROM export_pins WHERE export_id = ?",
							captured.id,
						)
						.toArray(),
				).toEqual([{ rev: 1 }]);
			});
		},
	);
});

describe("SQLite packed export parameter bounds", () => {
	it.each([17, 35])(
		"captures %i current files across parameter-safe batches and pins each one",
		async (count) => {
			const stub = env.VAULTS.get(
				env.VAULTS.idFromName(
					`packed-export-parameters-${count}-${crypto.randomUUID()}`,
				),
			);
			await runInDurableObject(stub, async (_instance, state) => {
				seedExportTextRows(state.storage, count);
				const store = new SqlitePackedExportStore(
					state.storage,
					noExportBlobReads(),
				);
				const captured = await store.capture(exportCreatedAt, 10);
				expect(captured.files).toHaveLength(count);
				expect(
					state.storage.sql
						.exec(
							"SELECT path, rev FROM export_pins WHERE export_id = ? ORDER BY path",
							captured.id,
						)
						.toArray(),
				).toEqual(
					captured.files
						.map(({ path, rev }) => ({ path, rev }))
						.sort((left, right) => left.path.localeCompare(right.path)),
				);
			});
		},
	);
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
			expect(
				await store.captureWhenIdle("2026-11-07T04:00:00.000Z", 101),
			).toBeNull();
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
			expect(await store.listResults()).toContainEqual({
				epoch: captured.epoch,
				created_at: exportCreatedAt,
				status: "failed",
				size: null,
				failure: { kind: "export_source_unavailable" },
			});
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
			blobs.head = async () => ({ hash, size: bytes.byteLength });
			blobs.read = async () =>
				new ReadableStream<Uint8Array>({
					/** Emit a short immutable range to model source truncation. */
					start(controller) {
						controller.enqueue(new Uint8Array([9]));
						controller.close();
					},
				});
			await expect(
				store.readSourceRange(captured.id, 0, 1, 3),
			).rejects.toBeInstanceOf(PackedExportSourceFailure);
		});
	});
});

describe("packed export SQLite row bounds", () => {
	it("persists a completed archive larger than one R2 part in bounded rows", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-row-bounds-${crypto.randomUUID()}`),
		);
		const epoch = "f".repeat(32);
		const bytes = new Uint8Array(5 * 1024 * 1024 + 13).fill(37);
		const hash = await hashExportBytes(bytes);
		const key = `backups/${epoch}/${exportCreatedAt}.zip`;
		const blobs: BlobContentStore = {
			/** Return the immutable fixture identity for every bounded source read. */
			async head() {
				return { hash, size: bytes.byteLength };
			},
			/** Reject writes because this archive test uses a read-only source. */
			async putVerified() {
				throw new Error("Unexpected blob write");
			},
			/** Emit only the requested immutable source range. */
			async read(_hash, _size, range) {
				if (!range) throw new Error("Expected a bounded source range");
				return new ReadableStream<Uint8Array>({
					/** Return the exact byte window for the ZIP step. */
					start(controller) {
						controller.enqueue(bytes.slice(range.start, range.end + 1));
						controller.close();
					},
				});
			},
		};
		await env.R2_BUCKET.delete(key);
		try {
			await runInDurableObject(stub, async (_instance, state) => {
				initializeVaultStorage(
					state.storage,
					() => epoch,
					() => 1,
				);
				state.storage.sql.exec(
					"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('assets/large.bin', 'assets/large.bin', 1, 1, ?, ?, 'blob', NULL, ?, NULL, 0, 1, 'test')",
					hash,
					bytes.byteLength,
					hash,
				);
				state.storage.sql.exec(
					"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES ('assets/large.bin', 1, ?, ?, 'blob', NULL, ?, 0, 'test', 1)",
					hash,
					bytes.byteLength,
					hash,
				);
				state.storage.sql.exec(
					"UPDATE meta SET value = '1' WHERE key IN ('live_file_count', 'head_seq')",
				);
				const repository = new SqlitePackedExportStore(state.storage, blobs);
				const service = new PackedExportService(
					repository,
					new R2PackedArchiveStore((env as Env).BACKUP_BUCKET),
				);
				expect((await service.start(exportCreatedAt, 1)).status).toBe("queued");
				let more = true;
				let batches = 0;
				while (more) {
					more = await service.runBatch();
					batches += 1;
					const rows = state.storage.sql
						.exec<{
							export_id: string;
							kind: string;
							ordinal: number;
							data_bytes: number;
						}>(
							"SELECT export_id, kind, ordinal, length(data) AS data_bytes FROM packed_export_chunks ORDER BY kind, ordinal",
						)
						.toArray();
					for (const row of rows) {
						const logicalRowBytes =
							new TextEncoder().encode(row.export_id).byteLength +
							new TextEncoder().encode(row.kind).byteLength +
							new TextEncoder().encode(String(row.ordinal)).byteLength +
							row.data_bytes +
							256;
						expect(row.data_bytes).toBeLessThanOrEqual(1_000_000);
						expect(logicalRowBytes).toBeLessThanOrEqual(2_000_000);
					}
					if (batches > 20)
						throw new Error("Large packed archive did not complete");
				}
				const [completed] = await repository.listCompleted();
				expect(completed?.size).toBeGreaterThan(5 * 1024 * 1024);
			});
		} finally {
			await env.R2_BUCKET.delete(key);
		}
	});
});

describe("packed export large manifests", () => {
	it("stores the maximum long-path manifest in bounded rows and reads it by ranges", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-long-paths-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			seedMaximumPathExportRows(state.storage);
			const store = new SqlitePackedExportStore(
				state.storage,
				noExportBlobReads(),
			);
			const captured = await store.capture(exportCreatedAt, 1);
			expect(captured.files).toHaveLength(10_000);
			expect(captured.files[0]?.path).toHaveLength(512);
			expect(captured.manifestSize).toBeGreaterThan(2_000_000);
			const rows = state.storage.sql
				.exec<{
					export_id: string;
					kind: string;
					ordinal: number;
					data_bytes: number;
				}>(
					"SELECT export_id, kind, ordinal, length(data) AS data_bytes FROM packed_export_chunks WHERE export_id = ? AND kind = 'manifest' ORDER BY ordinal",
					captured.id,
				)
				.toArray();
			expect(rows.length).toBeGreaterThan(2);
			for (const row of rows) {
				const logicalRowBytes =
					new TextEncoder().encode(row.export_id).byteLength +
					new TextEncoder().encode(row.kind).byteLength +
					new TextEncoder().encode(String(row.ordinal)).byteLength +
					row.data_bytes +
					256;
				expect(row.data_bytes).toBeLessThanOrEqual(1_000_000);
				expect(logicalRowBytes).toBeLessThanOrEqual(2_000_000);
			}
			const bytes = new Uint8Array(captured.manifestSize);
			for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
				const length = Math.min(65_536, bytes.byteLength - offset);
				bytes.set(
					await store.readManifestRange(captured.id, offset, length),
					offset,
				);
			}
			const manifest = ExportManifestSchema.parse(
				JSON.parse(new TextDecoder().decode(bytes)),
			);
			expect(manifest.files).toHaveLength(10_000);
			expect(manifest.files[0]?.path).toHaveLength(512);
			expect(manifest.files.at(-1)?.path).toHaveLength(512);
		});
	});
});

describe("packed export text query projection", () => {
	it("selects metadata without loading revision content before the bounded substr read", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-projection-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			const content = "bounded query bytes 🌱".repeat(100);
			const hash = await hashExportText(content);
			seedExportText(state.storage, "notes/projection.md", 1, content, hash);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key IN ('live_file_count', 'head_seq')",
			);
			const queries: string[] = [];
			const logger = {
				/** Record Drizzle metadata queries. Raw SQLite range queries bypass this logger. */
				logQuery(query: string) {
					queries.push(query);
				},
			};
			const store = new SqlitePackedExportStore(
				state.storage,
				noExportBlobReads(),
				logger,
			);
			const captured = await store.capture(exportCreatedAt, 10);
			const requested = 64;
			expect(
				await store.readSourceRange(captured.id, 0, 0, requested),
			).toHaveLength(requested);
			const projection = queries
				.filter(
					(query) =>
						query.toLowerCase().includes("revisions") &&
						query.toLowerCase().includes("case when"),
				)
				.at(-1);
			if (!projection)
				throw new Error("Packed-export metadata query was not logged");
			const selected = projection.slice(
				0,
				projection.toLowerCase().indexOf(" from "),
			);
			expect(selected).not.toMatch(
				/(?:`revisions`|"revisions")\.(?:`content`|"content")\s*(,|as)/i,
			);
			expect(selected).toMatch(/IS\s+NULL/i);
		});
	});
});

describe("packed export source retry", () => {
	it("retries a failed pinned range at the same cursor and keeps its pin", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-retry-${crypto.randomUUID()}`),
		);
		const epoch = "d".repeat(32);
		const bytes = new Uint8Array([7, 0, 255, 13, 42]);
		const hash = await hashExportBytes(bytes);
		const key = `backups/${epoch}/${exportCreatedAt}.zip`;
		const ranges: Array<{ start: number; end: number }> = [];
		let failNextRead = true;
		const blobs: BlobContentStore = {
			/** Return exact pinned hash and size evidence before each range. */
			async head() {
				return { hash, size: bytes.byteLength };
			},
			/** Reject writes because the export retry test reads one captured blob. */
			async putVerified() {
				throw new Error("Unexpected blob write");
			},
			/** Fail one source stream, then emit the requested immutable range. */
			async read(_hash, _size, range) {
				if (!range) throw new Error("Expected a bounded blob range");
				ranges.push(range);
				if (failNextRead) {
					failNextRead = false;
					return new ReadableStream<Uint8Array>({
						/** Reject once to model a transient R2 source read failure. */
						start(controller) {
							controller.error(new Error("Transient R2 range failure"));
						},
					});
				}
				return new ReadableStream<Uint8Array>({
					/** Emit the exact pinned byte range on retry. */
					start(controller) {
						controller.enqueue(bytes.slice(range.start, range.end + 1));
						controller.close();
					},
				});
			},
		};
		await env.R2_BUCKET.delete(key);
		try {
			await runInDurableObject(stub, async (_instance, state) => {
				initializeVaultStorage(
					state.storage,
					() => epoch,
					() => 1,
				);
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
					"UPDATE meta SET value = '1' WHERE key IN ('live_file_count', 'head_seq')",
				);
				const repository = new SqlitePackedExportStore(state.storage, blobs);
				const service = new PackedExportService(
					repository,
					new R2PackedArchiveStore((env as Env).BACKUP_BUCKET),
				);
				expect((await service.start(exportCreatedAt, 1)).status).toBe("queued");
				const initial = await repository.nextActive();
				if (!initial) throw new Error("Queued export disappeared");

				await service.runBatch();
				const afterFailure = await repository.nextActive();
				expect(afterFailure?.status).toBe("uploading");
				expect(afterFailure?.zipState).toBe(initial.zipState);
				expect(afterFailure?.pendingPart).toEqual(initial.pendingPart);
				expect(
					state.storage.sql
						.exec("SELECT rev FROM export_pins WHERE export_id = ?", initial.id)
						.toArray(),
				).toEqual([{ rev: 1 }]);

				await service.runBatch();
				const afterRetry = await repository.nextActive();
				expect(afterRetry?.zipState).not.toBe(initial.zipState);
				expect(ranges).toEqual([
					{ start: 0, end: bytes.byteLength - 1 },
					{ start: 0, end: bytes.byteLength - 1 },
				]);
				expect(
					state.storage.sql
						.exec("SELECT rev FROM export_pins WHERE export_id = ?", initial.id)
						.toArray(),
				).toEqual([{ rev: 1 }]);

				await service.runBatch();
				expect(
					(await repository.listCompleted()).map(({ status }) => status),
				).toEqual(["complete"]);
				expect(
					state.storage.sql
						.exec("SELECT * FROM export_pins WHERE export_id = ?", initial.id)
						.toArray(),
				).toEqual([]);
			});
		} finally {
			await env.R2_BUCKET.delete(key);
		}
	});
});

describe("packed export alarm dispatch", () => {
	it("exports mixed text and blob files and validates the completed ZIP independently", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`packed-export-alarm-${crypto.randomUUID()}`),
		);
		const text = "packed text bytes 🌱\n";
		const textBytes = new TextEncoder().encode(text);
		const textHash = await hashExportBytes(textBytes);
		const blobBytes = new TextEncoder().encode(
			`independent archive blob ${crypto.randomUUID()}`,
		);
		const blobHash = await hashExportBytes(blobBytes);
		const blobKey = `blobs/${blobHash}`;
		const createdAt = "2026-11-07T03:00:00.000Z";
		await env.R2_BUCKET.put(blobKey, blobBytes, {
			sha256: Uint8Array.from(blobHash.match(/.{2}/g) ?? [], (byte) =>
				Number.parseInt(byte, 16),
			),
		});
		let archiveKey: string | undefined;
		try {
			const result = await runInDurableObject(stub, async (instance, state) => {
				seedExportText(state.storage, "notes/a.md", 1, text, textHash);
				state.storage.sql.exec(
					"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('assets/x.bin', 'assets/x.bin', 1, 2, ?, ?, 'blob', NULL, ?, NULL, 0, 1, 'test')",
					blobHash,
					blobBytes.byteLength,
					blobHash,
				);
				state.storage.sql.exec(
					"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES ('assets/x.bin', 1, ?, ?, 'blob', NULL, ?, 0, 'test', 1)",
					blobHash,
					blobBytes.byteLength,
					blobHash,
				);
				state.storage.sql.exec(
					"UPDATE meta SET value = '2' WHERE key IN ('live_file_count', 'head_seq')",
				);
				const historyBytes =
					revisionLogicalPayloadBytes({
						path: "notes/a.md",
						rev: 1,
						hash: textHash,
						size: textBytes.byteLength,
						kind: "text",
						content: text,
						blobHash: null,
						deleted: 0,
						origin: "test",
						at: 1,
					}) +
					revisionLogicalPayloadBytes({
						path: "assets/x.bin",
						rev: 1,
						hash: blobHash,
						size: blobBytes.byteLength,
						kind: "blob",
						content: null,
						blobHash,
						deleted: 0,
						origin: "test",
						at: 1,
					});
				state.storage.sql.exec(
					"UPDATE meta SET value = ? WHERE key IN ('history_revisions_bytes', 'history_pressure_bytes')",
					String(historyBytes),
				);
				const started = await instance.startPackedExport(
					"synthetic-owner",
					createdAt,
				);
				expect(started?.status).toBe("queued");
				if (!started) throw new Error("Owner export did not start");
				archiveKey = `backups/${started.epoch}/${createdAt}.zip`;
				expect(await state.storage.getAlarm()).not.toBeNull();
				await instance.alarm();
				expect(await instance.listPackedExports("synthetic-owner")).toEqual([]);
				await instance.alarm();
				const snapshots = await instance.listPackedExports("synthetic-owner");
				expect(snapshots?.[0]?.status).toBe("complete");
				const archive = await instance.getPackedExportDownload(
					"synthetic-owner",
					started.epoch,
					createdAt,
				);
				if (!archive) throw new Error("Completed export has no archive stream");
				return {
					epoch: started.epoch,
					bytes: new Uint8Array(await new Response(archive.body).arrayBuffer()),
					size: archive.size,
				};
			});
			expect(result.bytes.byteLength).toBe(result.size);
			const files = unzipSync(result.bytes);
			expect(Object.keys(files).sort()).toEqual([
				"files/assets/x.bin",
				"files/notes/a.md",
				"manifest.json",
			]);
			const manifestBytes = files["manifest.json"];
			if (!manifestBytes) throw new Error("ZIP manifest is missing");
			const manifest = ExportManifestSchema.parse(
				JSON.parse(new TextDecoder().decode(manifestBytes)),
			);
			expect(manifest.epoch).toBe(result.epoch);
			expect(manifest.created_at).toBe(createdAt);
			expect(manifest.files).toEqual([
				{
					path: "assets/x.bin",
					rev: 1,
					hash: blobHash,
					size: blobBytes.byteLength,
				},
				{
					path: "notes/a.md",
					rev: 1,
					hash: textHash,
					size: textBytes.byteLength,
				},
			]);
			expect(files["files/assets/x.bin"]).toEqual(blobBytes);
			expect(files["files/notes/a.md"]).toEqual(textBytes);
			verifyStoredZipStructure(result.bytes, files);
		} finally {
			await env.R2_BUCKET.delete(blobKey);
			if (archiveKey) await (env as Env).BACKUP_BUCKET.delete(archiveKey);
		}
	});
});

describe("scheduled packed export admission", () => {
	it("keeps owner and scheduled starts within one active vault export", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`scheduled-export-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, async (vault, state) => {
			const starts = await Promise.all([
				vault.startScheduledPackedExport("2026-11-07T04:00:00.000Z"),
				vault.startPackedExport("synthetic-owner", "2026-11-07T05:00:00.000Z"),
			]);
			expect(starts.some((result) => result?.status === "queued")).toBe(true);
			const persisted = state.storage.sql
				.exec<{ created_at: string }>("SELECT created_at FROM packed_exports")
				.toArray();
			expect(persisted).toHaveLength(1);
			expect([
				"2026-11-07T04:00:00.000Z",
				"2026-11-07T05:00:00.000Z",
			]).toContain(persisted[0]?.created_at);
			const skipped = await vault.startScheduledPackedExport(
				"2026-11-07T06:00:00.000Z",
			);
			expect(skipped).toBeNull();
		});
	});
});
