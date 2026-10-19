import {
	EMPTY_PAYLOAD_HASH,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	RenameReservationSchema,
} from "@obsidian-ai-bridge/protocol";
import type { BlobStore } from "@worker/application/blobs";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import {
	captureTextStoreState,
	seedLiveTextState,
	TEXT_FIXTURE_CONTEXT,
	TEXT_FIXTURE_EPOCH,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it, vi } from "vitest";

/** Build an R2-shaped bucket whose object metadata has no trusted digest. */
function bucketWithHead(object: unknown): R2Bucket {
	return {
		head: async () => object as R2Object | null,
		get: async () => null,
		put: async () => null,
		delete: async () => undefined,
		list: async () => ({
			objects: [],
			truncated: false,
			delimitedPrefixes: [],
		}),
	} as unknown as R2Bucket;
}

/** Create one typed blob capability with controlled immutable integrity evidence. */
function blobStore(
	evidence: { hash: string; size: number } | undefined,
): BlobStore {
	return {
		head: async () => evidence,
		putVerified: async () => {
			throw new Error("Upload is outside this native publication test");
		},
	};
}

describe("R2 blob integrity evidence", () => {
	it("does not attest an object when the stored SHA-256 checksum is absent", async () => {
		const store = new R2BlobStore(
			bucketWithHead({
				key: `blobs/${"a".repeat(64)}`,
				size: 4,
				etag: "a".repeat(64),
				customMetadata: { sha256: "a".repeat(64) },
				checksums: {},
			}),
		);

		expect(await store.head("a".repeat(64))).toBeUndefined();
	});

	it("returns the stored checksum rather than trusting ETag or custom metadata", async () => {
		const hash = "a".repeat(64);
		const checksum = Uint8Array.from({ length: 32 }, () => 0xaa).buffer;
		const store = new R2BlobStore(
			bucketWithHead({
				key: `blobs/${hash}`,
				size: 4,
				etag: hash,
				customMetadata: { sha256: hash },
				checksums: { sha256: checksum },
			}),
		);

		expect(await store.head(hash)).toEqual({ hash: "aa".repeat(32), size: 4 });
	});
});

describe("native blob publication", () => {
	it("renames, restores, and reads retained blob references without copying objects", async () => {
		const hash = "8".repeat(64);
		const head = vi.fn(async () => ({ hash, size: 4 }));
		const capability = blobStore(undefined);
		capability.head = head;
		await withTextStore(
			async (fixture) => {
				const source = "attachments/source.pdf";
				const destination = "attachments/destination.pdf";
				const put = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [source],
					precondition: { kind: "absent" as const },
					payload_hash: hash,
					size: 4,
				};
				const putLease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					put,
				);
				if (!putLease.ok)
					throw new Error(`Reserve failed: ${putLease.failure.kind}`);
				const putTicket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					put,
					putLease.lease.admission_id,
				);
				if (!putTicket.ok)
					throw new Error(`Authorize failed: ${putTicket.failure.kind}`);
				expect(
					await fixture.store.commitBlob(
						TEXT_FIXTURE_CONTEXT,
						put,
						putTicket.ticket.id,
					),
				).toMatchObject({ ok: true });
				const renameBody = { to: destination };
				const renameText = JSON.stringify(renameBody);
				const renameDigest = await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(renameText),
				);
				const renameIntent = {
					op: "rename" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [source, destination],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash: Array.from(new Uint8Array(renameDigest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join(""),
					size: new TextEncoder().encode(renameText).byteLength,
				};
				const reservation = RenameReservationSchema.parse({
					path: source,
					if_match: renameIntent.precondition.etag,
				});
				const lease = await fixture.store.beginRenameSource(
					TEXT_FIXTURE_CONTEXT,
					reservation,
				);
				if (!lease.ok)
					throw new Error(`Rename reserve failed: ${lease.failure.kind}`);
				const authorized = await fixture.admissions.authorizeRenameSource(
					TEXT_FIXTURE_CONTEXT,
					renameIntent,
					lease.lease.admission_id,
				);
				if (!authorized.ok)
					throw new Error(
						`Rename authorization failed: ${authorized.failure.kind}`,
					);
				const rename = FileCommandSchema.parse({
					op: "rename",
					intent: renameIntent,
					body: renameBody,
				});
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						renameIntent,
						authorized.ticket.id,
						rename,
					),
				).toMatchObject({ ok: true });
				expect(
					fixture.storage.sql
						.exec("SELECT path, kind, blob_hash FROM files WHERE deleted = 0")
						.toArray(),
				).toEqual([{ path: destination, kind: "blob", blob_hash: hash }]);
				expect(
					await fixture.store.readBlobMetadata(TEXT_FIXTURE_CONTEXT, {
						path: source,
						epoch: TEXT_FIXTURE_EPOCH,
						rev: 1,
					}),
				).toMatchObject({ ok: true, body: { hash, size: 4 } });
				const restoreBody = { source_rev: 1, as_conflict_copy: true };
				const restoreText = JSON.stringify(restoreBody);
				const restoreDigest = await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(restoreText),
				);
				const restoreIntent = {
					op: "restore" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [source],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
					},
					payload_hash: Array.from(new Uint8Array(restoreDigest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join(""),
					size: new TextEncoder().encode(restoreText).byteLength,
				};
				const restoreKey = IdempotencyKeySchema.parse("blob-restore-key-01");
				const restore = FileCommandSchema.parse({
					op: "restore",
					intent: restoreIntent,
					body: restoreBody,
					key: restoreKey,
				});
				const restoreLease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					restoreIntent,
					restoreKey,
				);
				if (!restoreLease.ok)
					throw new Error(
						`Restore reserve failed: ${restoreLease.failure.kind}`,
					);
				const restoreTicket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					restoreIntent,
					restoreLease.lease.admission_id,
				);
				if (!restoreTicket.ok)
					throw new Error(
						`Restore authorization failed: ${restoreTicket.failure.kind}`,
					);
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						restoreIntent,
						restoreTicket.ticket.id,
						restore,
						restoreKey,
					),
				).toMatchObject({ ok: true });
				expect(
					fixture.storage.sql
						.exec("SELECT hash, size FROM blob_refs")
						.toArray(),
				).toEqual([{ hash, size: 4 }]);
				expect(head).toHaveBeenCalledTimes(1);
			},
			undefined,
			capability,
		);
	});
	it("refuses absent storage evidence without publishing any rows", async () => {
		const payload_hash = "a".repeat(64);
		const observed = vi.fn(async () => undefined);
		const store = blobStore(undefined);
		store.head = observed;
		await withTextStore(
			async (fixture) => {
				const before = captureTextStoreState(fixture.storage);
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/large.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					"invalid-ticket",
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "invalid_ticket" },
				});
				expect(observed).not.toHaveBeenCalled();
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			},
			undefined,
			store,
		);
	});

	it("rejects a key that does not own the active ticket before R2 access", async () => {
		const payload_hash = "1".repeat(64);
		const observed = vi.fn(async () => ({ hash: payload_hash, size: 4 }));
		const capability = blobStore(undefined);
		capability.head = observed;
		await withTextStore(
			async (fixture) => {
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/keyed.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const key = IdempotencyKeySchema.parse("blob-owner-key-0001");
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
					key,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
					IdempotencyKeySchema.parse("blob-other-key-0001"),
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "invalid_ticket" },
				});
				expect(observed).not.toHaveBeenCalled();
			},
			undefined,
			capability,
		);
	});

	it("moves from inline text to a verified blob without retaining searchable content", async () => {
		const payload_hash = "3".repeat(64);
		await withTextStore(
			async (fixture) => {
				await seedLiveTextState(fixture.storage, {
					path: "notes/transition.md",
					content: "old text",
				});
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["notes/transition.md"],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash,
					size: 1_500_000,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({ ok: true });
				expect(
					fixture.storage.sql
						.exec(
							"SELECT kind, content, blob_hash FROM files WHERE path = ?",
							"notes/transition.md",
						)
						.toArray(),
				).toEqual([{ kind: "blob", content: null, blob_hash: payload_hash }]);
				expect(
					fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
				).toEqual([]);
				expect(
					fixture.storage.sql
						.exec("SELECT kind, content FROM revisions ORDER BY rev")
						.toArray(),
				).toEqual([
					{ kind: "text", content: "old text" },
					{ kind: "blob", content: null },
				]);
			},
			undefined,
			blobStore({ hash: payload_hash, size: 1_500_000 }),
		);
	});

	it("deletes a blob by adding a tombstone and retains its immutable reference", async () => {
		const payload_hash = "7".repeat(64);
		await withTextStore(
			async (fixture) => {
				const put = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/delete.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					put,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					put,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				expect(
					await fixture.store.commitBlob(
						TEXT_FIXTURE_CONTEXT,
						put,
						ticket.ticket.id,
					),
				).toMatchObject({ ok: true });
				const deletion = {
					op: "delete" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/delete.pdf"],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash: EMPTY_PAYLOAD_HASH,
					size: 0,
				};
				const deleteLease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					deletion,
				);
				if (!deleteLease.ok)
					throw new Error(`Delete reserve failed: ${deleteLease.failure.kind}`);
				const deleteTicket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					deletion,
					deleteLease.lease.admission_id,
				);
				if (!deleteTicket.ok)
					throw new Error(
						`Delete authorization failed: ${deleteTicket.failure.kind}`,
					);
				expect(
					await fixture.store.commitText(
						TEXT_FIXTURE_CONTEXT,
						deletion,
						deleteTicket.ticket.id,
						undefined,
					),
				).toMatchObject({ ok: true });
				expect(
					fixture.storage.sql
						.exec("SELECT kind, deleted, hash, blob_hash FROM files")
						.toArray(),
				).toEqual([
					{ kind: "blob", deleted: 1, hash: "", blob_hash: payload_hash },
				]);
				expect(
					fixture.storage.sql
						.exec("SELECT hash, size FROM blob_refs")
						.toArray(),
				).toEqual([{ hash: payload_hash, size: 4 }]);
				expect(
					await fixture.store.readBlobMetadata(TEXT_FIXTURE_CONTEXT, {
						path: "attachments/delete.pdf",
						epoch: TEXT_FIXTURE_EPOCH,
					}),
				).toMatchObject({
					ok: true,
					body: { deleted: true, hash: "", size: 0 },
				});
			},
			undefined,
			blobStore({ hash: payload_hash, size: 4 }),
		);
	});

	it("moves from a blob to inline text and restores FTS ownership", async () => {
		const payload_hash = "4".repeat(64);
		await withTextStore(
			async (fixture) => {
				const blobIntent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["notes/reverse.md"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 1_500_000,
				};
				const blobLease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					blobIntent,
				);
				if (!blobLease.ok)
					throw new Error(`Reserve failed: ${blobLease.failure.kind}`);
				const blobTicket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					blobIntent,
					blobLease.lease.admission_id,
				);
				if (!blobTicket.ok)
					throw new Error(`Authorize failed: ${blobTicket.failure.kind}`);
				expect(
					await fixture.store.commitBlob(
						TEXT_FIXTURE_CONTEXT,
						blobIntent,
						blobTicket.ticket.id,
					),
				).toMatchObject({ ok: true });
				const content = "small replacement";
				const bytes = new TextEncoder().encode(content);
				const digest = await crypto.subtle.digest("SHA-256", bytes);
				const hash = Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["notes/reverse.md"],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash: hash,
					size: bytes.byteLength,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				expect(
					await fixture.store.commitText(
						TEXT_FIXTURE_CONTEXT,
						intent,
						ticket.ticket.id,
						content,
					),
				).toMatchObject({ ok: true });
				expect(
					fixture.storage.sql
						.exec(
							"SELECT kind, content, blob_hash FROM files WHERE path = ?",
							"notes/reverse.md",
						)
						.toArray(),
				).toEqual([{ kind: "text", content, blob_hash: null }]);
				expect(
					fixture.storage.sql
						.exec("SELECT path, content FROM files_fts")
						.toArray(),
				).toEqual([{ path: "notes/reverse.md", content }]);
			},
			undefined,
			blobStore({ hash: payload_hash, size: 1_500_000 }),
		);
	});

	it("publishes a verified large Markdown reference and replays receipts before R2 access", async () => {
		const payload_hash = "c".repeat(64);
		const key = IdempotencyKeySchema.parse("blob-replay-key-0001");
		const capability = blobStore({ hash: payload_hash, size: 1_500_000 });
		const head = vi.fn(capability.head);
		capability.head = head;
		await withTextStore(
			async (fixture) => {
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["notes/large.md"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 1_500_000,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
					key,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
					key,
				);
				expect(result).toMatchObject({
					ok: true,
					response: { body: { hash: payload_hash, size: 1_500_000 } },
				});
				const replay = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
					key,
				);
				expect(replay).toEqual(result);
				expect(head).toHaveBeenCalledTimes(1);
				expect(
					fixture.storage.sql
						.exec(
							"SELECT kind, hash, size, blob_hash, content FROM files WHERE path = ?",
							"notes/large.md",
						)
						.toArray(),
				).toEqual([
					{
						kind: "blob",
						hash: payload_hash,
						size: 1_500_000,
						blob_hash: payload_hash,
						content: null,
					},
				]);
				expect(
					fixture.storage.sql
						.exec("SELECT hash, size FROM blob_refs")
						.toArray(),
				).toEqual([{ hash: payload_hash, size: 1_500_000 }]);
				expect(
					fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
				).toEqual([]);
				expect(
					await fixture.store.readBlobMetadata(TEXT_FIXTURE_CONTEXT, {
						path: "notes/large.md",
						epoch: TEXT_FIXTURE_EPOCH,
					}),
				).toMatchObject({
					ok: true,
					body: { large: true, hash: payload_hash, size: 1_500_000 },
				});
			},
			undefined,
			capability,
		);
	});

	it.each([
		{ hash: "d".repeat(64), size: 4 },
		{ hash: "e".repeat(64), size: 5 },
	])(
		"rejects checksum or size mismatch without publishing rows",
		async (evidence) => {
			const payload_hash = "e".repeat(64);
			await withTextStore(
				async (fixture) => {
					const intent = {
						op: "put" as const,
						epoch: TEXT_FIXTURE_EPOCH,
						paths: ["attachments/mismatch.pdf"],
						precondition: { kind: "absent" as const },
						payload_hash,
						size: 4,
					};
					const lease = await fixture.store.beginMutation(
						TEXT_FIXTURE_CONTEXT,
						intent,
					);
					if (!lease.ok)
						throw new Error(`Reserve failed: ${lease.failure.kind}`);
					const ticket = await fixture.admissions.authorize(
						TEXT_FIXTURE_CONTEXT,
						intent,
						lease.lease.admission_id,
					);
					if (!ticket.ok)
						throw new Error(`Authorize failed: ${ticket.failure.kind}`);
					const before = captureTextStoreState(fixture.storage);
					const result = await fixture.store.commitBlob(
						TEXT_FIXTURE_CONTEXT,
						intent,
						ticket.ticket.id,
					);
					expect(result).toMatchObject({
						ok: false,
						failure: { kind: "blob_integrity_mismatch" },
					});
					expect(captureTextStoreState(fixture.storage)).toEqual(before);
				},
				undefined,
				blobStore(evidence),
			);
		},
	);

	it("rechecks revocation after the asynchronous R2 metadata read", async () => {
		const payload_hash = "f".repeat(64);
		let storage: DurableObjectStorage | undefined;
		const capability = blobStore({ hash: payload_hash, size: 4 });
		capability.head = async () => {
			storage?.sql.exec(
				"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
				TEXT_FIXTURE_CONTEXT.grant_id,
				20_000,
			);
			return { hash: payload_hash, size: 4 };
		};
		await withTextStore(
			async (fixture) => {
				storage = fixture.storage;
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/revoked.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "revoked" },
				});
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			},
			undefined,
			capability,
		);
	});

	it("rejects a ticket that expires during the R2 metadata await", async () => {
		const payload_hash = "2".repeat(64);
		let setNow: ((value: number) => void) | undefined;
		const capability = blobStore(undefined);
		capability.head = async () => {
			setNow?.(70_001);
			return { hash: payload_hash, size: 4 };
		};
		await withTextStore(
			async (fixture) => {
				setNow = fixture.setNow;
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/expired.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "invalid_ticket" },
				});
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			},
			undefined,
			capability,
		);
	});

	it("rechecks the observed epoch after the R2 metadata await", async () => {
		const payload_hash = "5".repeat(64);
		let storage: DurableObjectStorage | undefined;
		const capability = blobStore({ hash: payload_hash, size: 4 });
		capability.head = async () => {
			storage?.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'epoch'",
				"fedcba9876543210fedcba9876543210",
			);
			return { hash: payload_hash, size: 4 };
		};
		await withTextStore(
			async (fixture) => {
				storage = fixture.storage;
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/epoch.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "epoch_mismatch" },
				});
				const after = captureTextStoreState(fixture.storage);
				expect(after.files).toEqual(before.files);
				expect(after.revisions).toEqual(before.revisions);
				expect(after.changes).toEqual(before.changes);
				expect(after.blobRefs).toEqual(before.blobRefs);
			},
			undefined,
			capability,
		);
	});

	it("rechecks the exact current revision after the R2 metadata await", async () => {
		const payload_hash = "6".repeat(64);
		let storage: DurableObjectStorage | undefined;
		const capability = blobStore({ hash: payload_hash, size: 4 });
		capability.head = async () => {
			storage?.sql.exec(
				"UPDATE files SET rev = 2 WHERE path = ?",
				"attachments/stale.pdf",
			);
			return { hash: payload_hash, size: 4 };
		};
		await withTextStore(
			async (fixture) => {
				storage = fixture.storage;
				await seedLiveTextState(fixture.storage, {
					path: "attachments/stale.pdf",
					content: "old",
				});
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/stale.pdf"],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "precondition_failed" },
				});
				expect(
					fixture.storage.sql
						.exec("SELECT COUNT(*) AS count FROM revisions")
						.toArray(),
				).toEqual([{ count: 1 }]);
				expect(
					fixture.storage.sql
						.exec("SELECT COUNT(*) AS count FROM blob_refs")
						.toArray(),
				).toEqual([{ count: 0 }]);
				expect(
					fixture.storage.sql
						.exec("SELECT COUNT(*) AS count FROM changes")
						.toArray(),
				).toEqual([{ count: 1 }]);
				expect(before.blobRefs).toEqual([]);
			},
			undefined,
			capability,
		);
	});

	it("does not publish a declaration when stored checksum evidence is absent", async () => {
		const payload_hash = "b".repeat(64);
		const mock = blobStore(undefined);
		await withTextStore(
			async (fixture) => {
				const intent = {
					op: "put" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/large.pdf"],
					precondition: { kind: "absent" as const },
					payload_hash,
					size: 4,
				};
				const lease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					intent,
				);
				if (!lease.ok) throw new Error(`Reserve failed: ${lease.failure.kind}`);
				const ticket = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				);
				if (!ticket.ok)
					throw new Error(`Authorize failed: ${ticket.failure.kind}`);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitBlob(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
				);
				expect(result).toMatchObject({
					ok: false,
					failure: { kind: "blob_storage_unavailable" },
				});
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			},
			undefined,
			mock,
		);
	});
});
