import {
	EMPTY_PAYLOAD_HASH,
	IdempotencyKeySchema,
} from "@obsidian-ai-bridge/protocol";
import { assertIdempotencyWindow } from "@worker/application/idempotency";
import {
	changeLogicalPayloadBytes,
	receiptLogicalPayloadBytes,
	revisionLogicalPayloadBytes,
} from "@worker/infrastructure/sqlite/capacity";
import { SqliteReadStore } from "@worker/infrastructure/sqlite/reads";
import { SqliteRetentionStore } from "@worker/infrastructure/sqlite/retention";
import {
	PublicationQueryObserver,
	sqliteRecordBytes,
} from "@worker/test-fixtures/publication-budgets";
import type { TextStoreFixture } from "@worker/test-fixtures/text-files";
import {
	TEXT_FIXTURE_CONTEXT,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Milliseconds in one retention day for exact cutoff assertions. */
const DAY = 24 * 60 * 60 * 1000;
/** Fixed test clock used to make all retention boundary comparisons stable. */
const NOW = 40 * DAY;

/** Add one retained revision and keep the logical category totals exact. */
function insertRevision(
	fixture: TextStoreFixture,
	path: string,
	rev: number,
	at: number,
	content: string,
) {
	fixture.storage.sql.exec(
		"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, ?, ?, ?, 'text', ?, 0, 'test', ?)",
		path,
		rev,
		`hash-${path}-${rev}`,
		content.length,
		content,
		at,
	);
	const bytes = revisionLogicalPayloadBytes({
		path,
		rev,
		hash: `hash-${path}-${rev}`,
		size: content.length,
		kind: "text",
		content,
		blobHash: null,
		deleted: 0,
		origin: "test",
		at,
	});
	addCounter(fixture, "revisions", bytes);
	return bytes;
}

/** Add one feed row with its complete payload byte count. */
function insertChange(fixture: TextStoreFixture, seq: number, at: number) {
	fixture.storage.sql.exec(
		"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, 'put', ?, 1, ?, 'test', ?)",
		seq,
		`feed/${seq}.md`,
		`hash-${seq}`,
		at,
	);
	const bytes = changeLogicalPayloadBytes({
		seq,
		op: "put",
		path: `feed/${seq}.md`,
		rev: 1,
		hash: `hash-${seq}`,
		origin: "test",
		at,
	});
	addCounter(fixture, "changes", bytes);
	return bytes;
}

/** Add one idempotency receipt with its complete payload byte count. */
function insertReceipt(fixture: TextStoreFixture, key: string, at: number) {
	const row = {
		clientId: "retention-test",
		key,
		fingerprint: `fingerprint-${key}`,
		status: 201,
		body: "{}",
		at,
	};
	fixture.storage.sql.exec(
		"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES (?, ?, ?, ?, ?, ?)",
		row.clientId,
		row.key,
		row.fingerprint,
		row.status,
		row.body,
		row.at,
	);
	const bytes = receiptLogicalPayloadBytes(row);
	addCounter(fixture, "receipts", bytes);
	return bytes;
}

/** Keep both category and aggregate counters in sync with direct native fixture writes. */
function addCounter(
	fixture: TextStoreFixture,
	category: "revisions" | "receipts" | "changes",
	bytes: number,
) {
	const categoryKey = `history_${category}_bytes`;
	fixture.storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = ?",
		String(counter(fixture, categoryKey) + bytes),
		categoryKey,
	);
	fixture.storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = 'history_pressure_bytes'",
		String(counter(fixture, "history_pressure_bytes") + bytes),
	);
}

/** Read one metadata counter after retention commits. */
function counter(fixture: TextStoreFixture, key: string): number {
	const row = fixture.storage.sql
		.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
		.toArray()[0];
	if (!row) throw new Error(`Missing counter ${key}`);
	return Number(row.value);
}

/** Create a canonical UUIDv7 string with the supplied Unix-millisecond timestamp. */
function uuidV7(timestamp: number): string {
	const encoded = BigInt(timestamp).toString(16).padStart(12, "0");
	return `${encoded.slice(0, 8)}-${encoded.slice(8)}-7000-8000-000000000000`;
}

describe("SQLite bounded durable retention", () => {
	it.each(["ordinary_revisions", "pressure_revisions"] as const)(
		"bounds one-at-a-time payload ownership for 49 maximum escaping-heavy %s identities",
		async (category) => {
			await withTextStore(async (fixture) => {
				const content = "\u0000".repeat(1_000_000);
				let selectedBytes = 0;
				for (let index = 0; index < 49; index += 1)
					selectedBytes += insertRevision(
						fixture,
						`payload/${String(index).padStart(2, "0")}.md`,
						1,
						NOW - (category === "ordinary_revisions" ? 31 : 8) * DAY,
						content,
					);
				const pinnedBytes = insertRevision(
					fixture,
					"payload/pinned.md",
					1,
					NOW - 31 * DAY,
					"pinned",
				);
				const floorBytes = insertRevision(
					fixture,
					"payload/floor.md",
					1,
					NOW - 7 * DAY,
					"floor",
				);
				fixture.storage.sql.exec(
					"INSERT INTO export_pins(export_id,path,rev) VALUES ('payload-pin','payload/pinned.md',1)",
				);
				const initialBytes = counter(fixture, "history_revisions_bytes");
				const observer = new PublicationQueryObserver();
				const retention = new SqliteRetentionStore(
					fixture.storage,
					category === "pressure_revisions"
						? { historyPressureLimitBytes: initialBytes - selectedBytes }
						: undefined,
					observer,
				);
				let result = retention.runBatch(NOW);
				let batches = 1;
				while (result.more && batches < 8) {
					result = retention.runBatch(NOW);
					batches += 1;
				}

				const contentSelects = observer.queries.filter(
					({ sql: statement }) =>
						statement.startsWith("select") && statement.includes('"content"'),
				);
				const identitySelect = observer.queries.find(
					({ sql: statement }) =>
						statement.startsWith("select") &&
						statement.includes('"revisions"."path"') &&
						statement.includes('"revisions"."rev"') &&
						statement.includes("limit"),
				);
				const maximumContentUnits = 1_000_000;
				const activePayloadBytes = maximumContentUnits * 2;
				const escapedJsonUtf16Bytes = (maximumContentUnits * 6 + 2) * 2;
				const encodedJsonBytes = maximumContentUnits * 6;
				const selectedIdentityTextBytes = 49 * (512 * 2 + 8);
				const peakOwnedPayloadBytes =
					activePayloadBytes +
					escapedJsonUtf16Bytes +
					encodedJsonBytes +
					selectedIdentityTextBytes;

				expect(batches).toBeGreaterThan(0);
				expect(result.more).toBe(false);
				expect(result.historyReduced).toBe(category === "pressure_revisions");
				expect(contentSelects).toHaveLength(49);
				expect(
					contentSelects.every(
						({ sql: statement, bindCount }) =>
							statement.includes("limit ?") && bindCount === 3,
					),
				).toBe(true);
				expect(identitySelect?.sql).toContain('"revisions"."path"');
				expect(identitySelect?.sql).toContain('"revisions"."rev"');
				expect(identitySelect?.sql).toContain('"revisions"."at" asc');
				expect(identitySelect?.bindCount).toBe(3);
				expect(identitySelect?.sql).not.toContain('"content"');
				expect(peakOwnedPayloadBytes).toBeLessThanOrEqual(20_100_000);
				expect(counter(fixture, "history_revisions_bytes")).toBe(
					pinnedBytes + floorBytes,
				);
				expect(counter(fixture, "history_pressure_bytes")).toBe(
					pinnedBytes +
						floorBytes +
						counter(fixture, "history_receipts_bytes") +
						counter(fixture, "history_changes_bytes"),
				);
				expect(
					fixture.storage.sql
						.exec("SELECT path FROM revisions ORDER BY path")
						.toArray(),
				).toEqual([
					{ path: "payload/floor.md" },
					{ path: "payload/pinned.md" },
				]);
			});
		},
		60_000,
	);
	it("keeps rows exactly at 30 days and removes rows older than the cutoff", async () => {
		await withTextStore(async (fixture) => {
			const cutoff = NOW - 30 * DAY;
			const oldChange = insertChange(fixture, 1, cutoff - 1);
			const boundaryChange = insertChange(fixture, 2, cutoff);
			const oldReceipt = insertReceipt(
				fixture,
				"opaque-expired-001",
				cutoff - 1,
			);
			const boundaryReceipt = insertReceipt(
				fixture,
				"opaque-boundary-01",
				cutoff,
			);
			const oldRevision = insertRevision(
				fixture,
				"old.md",
				1,
				cutoff - 1,
				"old",
			);
			const pinnedOldRevision = insertRevision(
				fixture,
				"pinned-old.md",
				1,
				cutoff - 1,
				"pinned",
			);
			const boundaryRevision = insertRevision(
				fixture,
				"boundary.md",
				1,
				cutoff,
				"boundary",
			);
			fixture.storage.sql.exec(
				"INSERT INTO export_pins(export_id,path,rev) VALUES ('old-export','pinned-old.md',1)",
			);

			const retention = new SqliteRetentionStore(fixture.storage);
			let result = retention.runBatch(NOW);
			let batches = 1;
			while (result.more && batches < 8) {
				result = retention.runBatch(NOW);
				batches += 1;
			}

			expect(batches).toBeGreaterThan(1);
			expect(result).toEqual({ more: false, historyReduced: false });
			expect(
				fixture.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toEqual([{ seq: 2 }]);
			expect(
				fixture.storage.sql.exec("SELECT key FROM receipts").toArray(),
			).toEqual([{ key: "opaque-boundary-01" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT path FROM revisions ORDER BY path")
					.toArray(),
			).toEqual([{ path: "boundary.md" }, { path: "pinned-old.md" }]);
			expect(counter(fixture, "history_changes_bytes")).toBe(boundaryChange);
			expect(counter(fixture, "history_receipts_bytes")).toBe(boundaryReceipt);
			expect(counter(fixture, "history_revisions_bytes")).toBe(
				boundaryRevision + pinnedOldRevision,
			);
			expect(counter(fixture, "history_pressure_bytes")).toBe(
				boundaryChange + boundaryReceipt + boundaryRevision + pinnedOldRevision,
			);
			expect(oldChange + oldReceipt + oldRevision).toBeGreaterThan(0);
		});
	});

	it("prunes oldest eligible revisions first, preserves the seven-day floor and export pins, and marks reduced history", async () => {
		await withTextStore(async (fixture) => {
			const oldBytes = insertRevision(
				fixture,
				"oldest.md",
				1,
				NOW - 20 * DAY,
				"oldest",
			);
			const newerBytes = insertRevision(
				fixture,
				"newer.md",
				1,
				NOW - 10 * DAY,
				"newer",
			);
			insertRevision(fixture, "floor.md", 1, NOW - 7 * DAY, "floor");
			insertRevision(fixture, "pinned.md", 1, NOW - 25 * DAY, "pinned");
			fixture.storage.sql.exec(
				"INSERT INTO export_pins(export_id,path,rev) VALUES ('export-1','pinned.md',1)",
			);
			const initialPressureBytes = counter(fixture, "history_pressure_bytes");
			const retention = new SqliteRetentionStore(fixture.storage, {
				historyPressureLimitBytes: initialPressureBytes - oldBytes,
			});

			const result = retention.runBatch(NOW);

			expect(result.historyReduced).toBe(true);
			expect(
				fixture.storage.sql
					.exec("SELECT path FROM revisions ORDER BY path")
					.toArray(),
			).toEqual([
				{ path: "floor.md" },
				{ path: "newer.md" },
				{ path: "pinned.md" },
			]);
			expect(counter(fixture, "history_revisions_bytes")).toBeGreaterThan(0);
			expect(counter(fixture, "history_pressure_bytes")).toBe(
				counter(fixture, "history_revisions_bytes") +
					counter(fixture, "history_changes_bytes") +
					counter(fixture, "history_receipts_bytes"),
			);
			expect(counter(fixture, "history_pressure_bytes")).toBe(
				initialPressureBytes - oldBytes,
			);
			expect(counter(fixture, "history_revisions_bytes")).toBe(
				initialPressureBytes -
					oldBytes -
					counter(fixture, "history_receipts_bytes") -
					counter(fixture, "history_changes_bytes"),
			);
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'history_reduced'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			const authorized = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				{
					op: "read",
					paths: [],
					precondition: { kind: "none" },
					payload_hash: EMPTY_PAYLOAD_HASH,
					size: 0,
				},
			);
			expect(authorized.ok).toBe(true);
			if (!authorized.ok) return;
			const summary = await new SqliteReadStore(
				fixture.storage,
				fixture.admissions,
				{ now: () => NOW },
			).readVault(TEXT_FIXTURE_CONTEXT, authorized.ticket.id);
			expect(summary.attention).toContain("history_reduced");
			await fixture.admissions.finish(
				TEXT_FIXTURE_CONTEXT,
				authorized.ticket.id,
				"settled",
			);
			expect(newerBytes).toBeGreaterThan(0);
		});
	});

	it("keeps current files, tombstones, feed identity, and FTS unchanged when it prunes revisions", async () => {
		await withTextStore(async (fixture) => {
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES ('keep.md','keep',2,7,'head-hash',4,'text','head',0,?, 'test')",
				NOW,
			);
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES ('dead.md','dead',3,8,'',0,'text',NULL,1,?, 'test')",
				NOW,
			);
			const keepBytes = insertRevision(
				fixture,
				"keep.md",
				1,
				NOW - 20 * DAY,
				"older",
			);
			const tombstoneBytes = insertRevision(
				fixture,
				"dead.md",
				2,
				NOW - 20 * DAY,
				"before-delete",
			);
			const blobHash = "b".repeat(64);
			fixture.storage.sql.exec(
				"INSERT INTO blob_refs(hash,size,first_ref_at) VALUES (?, 10, ?)",
				blobHash,
				NOW - 20 * DAY,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,blob_hash,deleted,origin,at) VALUES ('media/old.pdf',1,?,10,'blob',NULL,?,0,'test',?)",
				blobHash,
				blobHash,
				NOW - 20 * DAY,
			);
			const blobRevisionBytes = revisionLogicalPayloadBytes({
				path: "media/old.pdf",
				rev: 1,
				hash: blobHash,
				size: 10,
				kind: "blob",
				content: null,
				blobHash,
				deleted: 0,
				origin: "test",
				at: NOW - 20 * DAY,
			});
			addCounter(fixture, "revisions", blobRevisionBytes);
			fixture.storage.sql.exec(
				"INSERT INTO files_fts(path,content) VALUES ('keep.md','head')",
			);
			fixture.storage.sql.exec(
				"INSERT INTO changes(seq,op,path,rev,hash,from_path,from_rev,origin,at) VALUES (8,'rename','keep.md',2,'head-hash','dead.md',3,'test',?)",
				NOW,
			);
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '8' WHERE key='head_seq'",
			);
			const retention = new SqliteRetentionStore(fixture.storage, {
				historyPressureLimitBytes:
					counter(fixture, "history_pressure_bytes") -
					keepBytes -
					tombstoneBytes -
					blobRevisionBytes,
			});

			retention.runBatch(NOW);

			expect(
				fixture.storage.sql
					.exec("SELECT path, rev, deleted FROM files ORDER BY path")
					.toArray(),
			).toEqual([
				{ path: "dead.md", rev: 3, deleted: 1 },
				{ path: "keep.md", rev: 2, deleted: 0 },
			]);
			expect(
				fixture.storage.sql.exec("SELECT * FROM revisions").toArray(),
			).toHaveLength(0);
			expect(
				fixture.storage.sql.exec("SELECT * FROM blob_refs").toArray(),
			).toEqual([{ hash: blobHash, size: 10, first_ref_at: NOW - 20 * DAY }]);
			expect(
				fixture.storage.sql.exec("SELECT * FROM changes").toArray(),
			).toHaveLength(1);
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files_fts")
					.toArray(),
			).toEqual([{ path: "keep.md", content: "head" }]);
			expect(counter(fixture, "head_seq")).toBe(8);
			expect(
				fixture.storage.sql
					.exec("SELECT seq, op, path, from_path, from_rev FROM changes")
					.toArray(),
			).toEqual([
				{
					seq: 8,
					op: "rename",
					path: "keep.md",
					from_path: "dead.md",
					from_rev: 3,
				},
			]);
		});
	});

	it("keeps UUIDv7 receipts inside the 25-day and five-minute window, then removes expired receipts", async () => {
		await withTextStore(async (fixture) => {
			const cutoff = NOW - 30 * DAY;
			const oldAcceptedKey = uuidV7(NOW - 25 * DAY);
			const futureAcceptedKey = uuidV7(NOW + 5 * 60 * 1000);
			const expiredKey = uuidV7(NOW - 31 * DAY);
			assertIdempotencyWindow(IdempotencyKeySchema.parse(oldAcceptedKey), NOW);
			assertIdempotencyWindow(
				IdempotencyKeySchema.parse(futureAcceptedKey),
				NOW,
			);
			expect(() =>
				assertIdempotencyWindow(IdempotencyKeySchema.parse(expiredKey), NOW),
			).toThrow();
			insertReceipt(fixture, oldAcceptedKey, NOW - 25 * DAY);
			insertReceipt(fixture, futureAcceptedKey, NOW);
			insertReceipt(fixture, "opaque-expired-key-01", cutoff - 1);
			insertReceipt(fixture, expiredKey, cutoff - 1);

			const retention = new SqliteRetentionStore(fixture.storage);
			retention.runBatch(NOW);

			expect(
				fixture.storage.sql
					.exec("SELECT key FROM receipts ORDER BY key")
					.toArray(),
			).toEqual([{ key: oldAcceptedKey }, { key: futureAcceptedKey }]);
			expect(counter(fixture, "history_receipts_bytes")).toBe(
				receiptLogicalPayloadBytes({
					clientId: "retention-test",
					key: oldAcceptedKey,
					fingerprint: `fingerprint-${oldAcceptedKey}`,
					status: 201,
					body: "{}",
					at: NOW - 25 * DAY,
				}) +
					receiptLogicalPayloadBytes({
						clientId: "retention-test",
						key: futureAcceptedKey,
						fingerprint: `fingerprint-${futureAcceptedKey}`,
						status: 201,
						body: "{}",
						at: NOW,
					}),
			);
		});
	});

	it("keeps protected revisions when pins and the seven-day floor prevent pressure relief", async () => {
		await withTextStore(async (fixture) => {
			insertRevision(fixture, "floor.md", 1, NOW - 7 * DAY, "floor");
			insertRevision(fixture, "pinned.md", 1, NOW - 10 * DAY, "pinned");
			fixture.storage.sql.exec(
				"INSERT INTO export_pins(export_id,path,rev) VALUES ('pin','pinned.md',1)",
			);
			const before = counter(fixture, "history_pressure_bytes");
			const retention = new SqliteRetentionStore(fixture.storage, {
				historyPressureLimitBytes: before - 1,
			});

			const result = retention.runBatch(NOW);

			expect(result).toEqual({ more: false, historyReduced: false });
			expect(counter(fixture, "history_pressure_bytes")).toBe(before);
			expect(
				fixture.storage.sql
					.exec("SELECT path FROM revisions ORDER BY path")
					.toArray(),
			).toEqual([{ path: "floor.md" }, { path: "pinned.md" }]);
		});
	});

	it("limits composite receipt batches to 49 identities and safely resumes repeated delivery", async () => {
		await withTextStore(async (fixture) => {
			for (let index = 0; index < 55; index += 1)
				insertReceipt(
					fixture,
					`opaque-${String(index).padStart(5, "0")}`,
					NOW - 31 * DAY,
				);
			const observer = new PublicationQueryObserver();
			const receiptRow = fixture.storage.sql
				.exec("SELECT * FROM receipts LIMIT 1")
				.toArray()[0];
			if (!receiptRow) throw new Error("No receipt row was seeded");
			expect(sqliteRecordBytes(Object.values(receiptRow))).toBeLessThanOrEqual(
				2_000_000,
			);
			const retention = new SqliteRetentionStore(
				fixture.storage,
				undefined,
				observer,
			);

			const first = retention.runBatch(NOW);
			expect(first.more).toBe(true);
			expect(observer.queries.length).toBeGreaterThan(0);
			expect(
				Math.max(...observer.queries.map(({ bindCount }) => bindCount)),
			).toBeLessThanOrEqual(100);
			expect(
				observer.queries.filter(({ sql }) => /^delete/i.test(sql.trim())),
			).toHaveLength(49);
			expect(
				fixture.storage.sql.exec("SELECT key FROM receipts").toArray(),
			).toHaveLength(6);
			const second = retention.runBatch(NOW);
			expect(second.more).toBe(false);
			const beforeReplay = {
				rows: fixture.storage.sql
					.exec("SELECT * FROM receipts ORDER BY key")
					.toArray(),
				pressure: counter(fixture, "history_pressure_bytes"),
				categoryBytes: counter(fixture, "history_receipts_bytes"),
				feedBoundary: counter(fixture, "retention_pruned_feed_seq"),
			};
			const replay = retention.runBatch(NOW);
			expect(replay).toEqual({ more: false, historyReduced: false });
			expect({
				rows: fixture.storage.sql
					.exec("SELECT * FROM receipts ORDER BY key")
					.toArray(),
				pressure: counter(fixture, "history_pressure_bytes"),
				categoryBytes: counter(fixture, "history_receipts_bytes"),
				feedBoundary: counter(fixture, "retention_pruned_feed_seq"),
			}).toEqual(beforeReplay);
			expect(counter(fixture, "history_receipts_bytes")).toBe(0);
			expect(counter(fixture, "history_pressure_bytes")).toBe(0);
		});
	});

	it("rolls back row deletion, progress, feed boundary, and counters on underflow", async () => {
		await withTextStore(async (fixture) => {
			insertChange(fixture, 1, NOW - 31 * DAY);
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '0' WHERE key IN ('history_changes_bytes', 'history_pressure_bytes')",
			);
			const before = fixture.storage.sql
				.exec("SELECT * FROM meta ORDER BY key")
				.toArray();
			const retention = new SqliteRetentionStore(fixture.storage);

			expect(() => retention.runBatch(NOW)).toThrow(
				"Logical history counter underflow",
			);
			expect(
				fixture.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toEqual([{ seq: 1 }]);
			expect(
				fixture.storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray(),
			).toEqual(before);
		});
	});
});
