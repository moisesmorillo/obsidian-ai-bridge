import {
	type AuthorizationContext,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import type { BlobStore } from "@worker/application/blobs";
import { prepareTextPayload } from "@worker/application/text-payload";
import {
	capacityAttention,
	changeLogicalPayloadBytes,
	logicalPayloadBytes,
	receiptLogicalPayloadBytes,
	revisionLogicalPayloadBytes,
	SQLITE_CAPACITY_LIMITS,
} from "@worker/infrastructure/sqlite/capacity";
import type { TextStoreFixture } from "@worker/test-fixtures/text-files";
import {
	captureTextStoreState,
	seedLiveTextState,
	TEXT_FIXTURE_CONTEXT,
	TEXT_FIXTURE_EPOCH,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Reserve, authorize, and commit one valid history command through native SQLite. */
async function commitCommand(
	fixture: TextStoreFixture,
	command: ReturnType<typeof FileCommandSchema.parse>,
) {
	const key = "key" in command ? command.key : undefined;
	const reservation = await fixture.coordinator.beginMutation(
		TEXT_FIXTURE_CONTEXT,
		{
			op: command.op,
			epoch: command.intent.epoch,
			paths: command.intent.paths,
			precondition: command.intent.precondition,
		},
		key,
	);
	if (!reservation.ok)
		throw new Error(`Reservation failed: ${reservation.failure.kind}`);
	const admission = await fixture.admissions.authorize(
		TEXT_FIXTURE_CONTEXT,
		command.intent,
		reservation.lease.admission_id,
	);
	if (!admission.ok)
		throw new Error(`Authorization failed: ${admission.failure.kind}`);
	return fixture.store.commitFileCommand(
		TEXT_FIXTURE_CONTEXT,
		command.intent,
		admission.ticket.id,
		command,
		key,
	);
}

describe("SQLite capacity observations", () => {
	it("uses inclusive storage, live-file, and referenced-blob alert thresholds", () => {
		expect(
			capacityAttention(
				SQLITE_CAPACITY_LIMITS.databaseAlertBytes - 1,
				SQLITE_CAPACITY_LIMITS.liveFileLimit - 1,
				false,
				SQLITE_CAPACITY_LIMITS.blobAlertBytes - 1,
			),
		).toEqual([]);
		expect(
			capacityAttention(
				SQLITE_CAPACITY_LIMITS.databaseAlertBytes,
				SQLITE_CAPACITY_LIMITS.liveFileLimit,
				true,
				SQLITE_CAPACITY_LIMITS.blobAlertBytes,
			),
		).toEqual([
			"storage_high",
			"capacity_exceeded",
			"history_reduced",
			"blob_storage_high",
		]);
		expect(
			capacityAttention(SQLITE_CAPACITY_LIMITS.databaseLimitBytes, 0, false, 0),
		).toEqual(["storage_high", "capacity_exceeded"]);
	});

	it("counts deterministic UTF-8 JSON payload bytes and null values", () => {
		const payload = ["café🙂\u0000", null, `blobs/${"a".repeat(64)}`];
		expect(logicalPayloadBytes(payload)).toBe(
			new TextEncoder().encode(JSON.stringify(payload)).byteLength,
		);
	});

	it("counts restore revision, change, and receipt rows in their categories", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/source.md";
			await seedLiveTextState(fixture.storage, { path, content: "source" });
			const body = { source_rev: 1, as_conflict_copy: true };
			const encodedBody = JSON.stringify(body);
			const payload = await prepareTextPayload(
				new TextEncoder().encode(encodedBody),
			);
			const command = FileCommandSchema.parse({
				op: "restore",
				intent: {
					op: "restore",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: {
						kind: "match",
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash: payload.payload_hash,
					size: payload.size,
				},
				body,
				key: IdempotencyKeySchema.parse("capacity-restore-count-01"),
			});
			const result = await commitCommand(fixture, command);
			expect(result, JSON.stringify(result)).toMatchObject({
				ok: true,
				response: { status: 200 },
			});
			const revision = fixture.storage.sql
				.exec<{
					path: string;
					rev: number;
					hash: string;
					size: number;
					kind: string;
					content: string | null;
					blob_hash: string | null;
					deleted: number;
					origin: string;
					at: number;
				}>("SELECT * FROM revisions WHERE path = ? AND rev = 2", path)
				.toArray()[0];
			const change = fixture.storage.sql
				.exec<{
					seq: number;
					op: string;
					path: string;
					rev: number;
					hash: string;
					from_path: string | null;
					from_rev: number | null;
					origin: string;
					at: number;
				}>("SELECT * FROM changes WHERE seq = 2")
				.toArray()[0];
			const receipt = fixture.storage.sql
				.exec<{
					client_id: string;
					key: string;
					fingerprint: string;
					status: number;
					body: string;
					at: number;
				}>("SELECT * FROM receipts WHERE key = ?", command.key)
				.toArray()[0];
			expect(revision).toBeDefined();
			expect(change).toBeDefined();
			expect(receipt).toBeDefined();
			const revisionBytes = revisionLogicalPayloadBytes({
				path: revision?.path ?? "",
				rev: revision?.rev ?? 0,
				hash: revision?.hash ?? "",
				size: revision?.size ?? 0,
				kind: revision?.kind ?? "",
				content: revision?.content ?? null,
				blobHash: revision?.blob_hash ?? null,
				deleted: revision?.deleted ?? 0,
				origin: revision?.origin ?? "",
				at: revision?.at ?? 0,
			});
			const changeBytes = changeLogicalPayloadBytes({
				seq: change?.seq ?? 0,
				op: change?.op ?? "",
				path: change?.path ?? "",
				rev: change?.rev ?? 0,
				hash: change?.hash ?? "",
				fromPath: change?.from_path ?? null,
				fromRev: change?.from_rev ?? null,
				origin: change?.origin ?? "",
				at: change?.at ?? 0,
			});
			const receiptBytes = receiptLogicalPayloadBytes({
				clientId: receipt?.client_id ?? "",
				key: receipt?.key ?? "",
				fingerprint: receipt?.fingerprint ?? "",
				status: receipt?.status ?? 0,
				body: receipt?.body ?? "",
				at: receipt?.at ?? 0,
			});
			const counters = Object.fromEntries(
				fixture.storage.sql
					.exec<{ key: string; value: string }>(
						"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
					)
					.toArray()
					.map(({ key, value }) => [key, Number(value)]),
			);
			expect(counters).toEqual({
				history_changes_bytes: changeBytes,
				history_pressure_bytes: revisionBytes + changeBytes + receiptBytes,
				history_receipts_bytes: receiptBytes,
				history_revisions_bytes: revisionBytes,
			});
		});
	});

	it.each([
		[
			"live-file cap",
			{
				databaseAlertBytes: 2_000_000_000,
				databaseLimitBytes: 2_100_000_000,
				liveFileLimit: 1,
				historyPressureLimitBytes: 1_000_000_000,
				blobAlertBytes: 4_000_000_000,
			},
		],
		[
			"database cap only",
			{
				databaseAlertBytes: 1,
				databaseLimitBytes: 1,
				liveFileLimit: 2,
				historyPressureLimitBytes: 1,
				blobAlertBytes: 1,
			},
		],
	] as const)(
		"returns stale-precondition refusal before the %s without consuming admission state",
		async (_capacity, limits) => {
			await withTextStore(
				async (fixture) => {
					const path = "notes/source.md";
					await seedLiveTextState(fixture.storage, {
						path,
						content: "revision two",
						revision: 2,
					});
					const liveCount = fixture.storage.sql
						.exec<{ count: number }>(
							"SELECT count(*) AS count FROM files WHERE deleted = 0",
						)
						.toArray()[0]?.count;
					if (_capacity === "live-file cap") {
						expect(liveCount).toBe(limits.liveFileLimit);
						expect(fixture.storage.sql.databaseSize).toBeLessThan(
							limits.databaseLimitBytes,
						);
					} else {
						expect(liveCount).toBeLessThan(limits.liveFileLimit);
						expect(fixture.storage.sql.databaseSize).toBeGreaterThanOrEqual(
							limits.databaseLimitBytes,
						);
					}
					const context: AuthorizationContext = {
						...TEXT_FIXTURE_CONTEXT,
						scopes: ["vault:write"],
					};
					const payload = await prepareTextPayload(
						new TextEncoder().encode("x"),
					);
					const intent = TextMutationIntentSchema.parse({
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: {
							kind: "match",
							etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
						},
						payload_hash: payload.payload_hash,
						size: payload.size,
					});
					const lease = await fixture.coordinator.beginMutation(context, {
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: intent.precondition,
					});
					expect(lease.ok).toBe(true);
					if (!lease.ok) return;
					const admission = await fixture.admissions.authorize(
						context,
						intent,
						lease.lease.admission_id,
					);
					expect(admission.ok).toBe(true);
					if (!admission.ok) return;
					const before = captureTextStoreState(fixture.storage);
					const result = await fixture.store.commitText(
						context,
						intent,
						admission.ticket.id,
						payload.content,
					);
					expect(result).toMatchObject({
						ok: false,
						failure: {
							kind: "precondition_failed",
							etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
						},
					});
					if (!result.ok) expect("content" in result.failure).toBe(false);
					else throw new Error("Expected stale precondition refusal");
					const after = captureTextStoreState(fixture.storage);
					expect(after.files).toEqual(before.files);
					expect(after.revisions).toEqual(before.revisions);
					expect(after.changes).toEqual(before.changes);
					expect(after.receipts).toEqual(before.receipts);
					expect(after.blobRefs).toEqual(before.blobRefs);
					expect(after.meta).toEqual(before.meta);
					expect(after.admissions).toEqual(before.admissions);
					expect(after.claims).toEqual(before.claims);
				},
				undefined,
				undefined,
				limits,
			);
		},
	);

	it("replays a matching receipt at live-file capacity without changing publication state", async () => {
		await withTextStore(
			async (fixture) => {
				const context = TEXT_FIXTURE_CONTEXT;
				const path = "notes/receipt.md";
				const key = IdempotencyKeySchema.parse("capacity-receipt-replay-01");
				const payload = await prepareTextPayload(
					new TextEncoder().encode("saved"),
				);
				const intent = TextMutationIntentSchema.parse({
					op: "put",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: { kind: "absent" },
					payload_hash: payload.payload_hash,
					size: payload.size,
				});
				const lease = await fixture.coordinator.beginMutation(
					context,
					{
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: intent.precondition,
					},
					key,
				);
				if (!lease.ok) throw new Error(lease.failure.kind);
				const admission = await fixture.admissions.authorize(
					context,
					intent,
					lease.lease.admission_id,
				);
				if (!admission.ok) throw new Error(admission.failure.kind);
				const first = await fixture.store.commitText(
					context,
					intent,
					admission.ticket.id,
					payload.content,
					key,
				);
				expect(first.ok).toBe(true);
				const beforeReplay = captureTextStoreState(fixture.storage);
				const replay = await fixture.store.commitText(
					context,
					intent,
					admission.ticket.id,
					payload.content,
					key,
				);
				expect(replay).toEqual(first);
				expect(captureTextStoreState(fixture.storage)).toEqual(beforeReplay);
			},
			undefined,
			undefined,
			{
				databaseAlertBytes: 2_000_000_000,
				databaseLimitBytes: 2_100_000_000,
				liveFileLimit: 1,
				historyPressureLimitBytes: 1_000_000_000,
				blobAlertBytes: 4_000_000_000,
			},
		);
	});

	it.each([
		["occupied create path", "notes/source.md", "precondition_failed"],
		["case-fold path collision", "Notes/Source.md", "path_collision"],
	] as const)(
		"returns %s before live-file capacity without consuming admission state",
		async (_case, path, failure) => {
			await withTextStore(
				async (fixture) => {
					await seedLiveTextState(fixture.storage, {
						path: "notes/source.md",
						content: "current",
					});
					const context: AuthorizationContext = {
						...TEXT_FIXTURE_CONTEXT,
						scopes: ["vault:write"],
					};
					const payload = await prepareTextPayload(
						new TextEncoder().encode("new"),
					);
					const intent = TextMutationIntentSchema.parse({
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: { kind: "absent" },
						payload_hash: payload.payload_hash,
						size: payload.size,
					});
					const lease = await fixture.coordinator.beginMutation(context, {
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: intent.precondition,
					});
					if (!lease.ok) throw new Error(lease.failure.kind);
					const admission = await fixture.admissions.authorize(
						context,
						intent,
						lease.lease.admission_id,
					);
					if (!admission.ok) throw new Error(admission.failure.kind);
					const before = captureTextStoreState(fixture.storage);
					const result = await fixture.store.commitText(
						context,
						intent,
						admission.ticket.id,
						payload.content,
					);
					expect(result).toMatchObject({
						ok: false,
						failure:
							failure === "path_collision"
								? { kind: failure, existing_path: "notes/source.md" }
								: { kind: failure },
					});
					const after = captureTextStoreState(fixture.storage);
					expect(after.files).toEqual(before.files);
					expect(after.revisions).toEqual(before.revisions);
					expect(after.changes).toEqual(before.changes);
					expect(after.receipts).toEqual(before.receipts);
					expect(after.blobRefs).toEqual(before.blobRefs);
					expect(after.meta).toEqual(before.meta);
					expect(after.admissions).toEqual(before.admissions);
					expect(after.claims).toEqual(before.claims);
				},
				undefined,
				undefined,
				{
					databaseAlertBytes: 2_000_000_000,
					databaseLimitBytes: 2_100_000_000,
					liveFileLimit: 1,
					historyPressureLimitBytes: 1_000_000_000,
					blobAlertBytes: 4_000_000_000,
				},
			);
		},
	);

	it("refuses blob, append, rename, and restore publication at the live-file cap", async () => {
		const capacityLimits = {
			databaseAlertBytes: 1_500_000_000,
			databaseLimitBytes: 2_000_000_000,
			liveFileLimit: 1,
			historyPressureLimitBytes: 1_000_000_000,
			blobAlertBytes: 4_000_000_000,
		};
		const blobHash = "a".repeat(64);
		const blobStore: BlobStore = {
			head: async () => ({ hash: blobHash, size: 1_000_001 }),
			putVerified: async () => {
				throw new Error("Upload is outside this capacity test");
			},
		};
		await withTextStore(
			async (fixture) => {
				const path = "notes/source.md";
				await seedLiveTextState(fixture.storage, { path, content: "source" });
				const before = captureTextStoreState(fixture.storage);
				const blobIntent = TextMutationIntentSchema.parse({
					op: "put",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["attachments/data.bin"],
					precondition: { kind: "absent" },
					payload_hash: blobHash,
					size: 1_000_001,
				});
				const blobLease = await fixture.store.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					{
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: blobIntent.paths,
						precondition: blobIntent.precondition,
					},
				);
				if (!blobLease.ok)
					throw new Error(`Blob reservation failed: ${blobLease.failure.kind}`);
				const blobAdmission = await fixture.admissions.authorize(
					TEXT_FIXTURE_CONTEXT,
					blobIntent,
					blobLease.lease.admission_id,
				);
				if (!blobAdmission.ok)
					throw new Error(
						`Blob authorization failed: ${blobAdmission.failure.kind}`,
					);
				expect(
					await fixture.store.commitBlob(
						TEXT_FIXTURE_CONTEXT,
						blobIntent,
						blobAdmission.ticket.id,
					),
				).toEqual({ ok: false, failure: { kind: "capacity_exceeded" } });

				const append = await prepareTextPayload(
					new TextEncoder().encode("more"),
				);
				const appendCommand = FileCommandSchema.parse({
					op: "append",
					intent: {
						op: "append",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: { kind: "none" },
						payload_hash: append.payload_hash,
						size: append.size,
					},
					content: append.content,
					key: IdempotencyKeySchema.parse("capacity-append-0001"),
				});
				expect(await commitCommand(fixture, appendCommand)).toEqual({
					ok: false,
					failure: { kind: "capacity_exceeded" },
				});

				const renameBody = { to: "notes/renamed.md" };
				const renameBytes = JSON.stringify(renameBody);
				const renamePayload = await prepareTextPayload(
					new TextEncoder().encode(renameBytes),
				);
				const renameCommand = FileCommandSchema.parse({
					op: "rename",
					intent: {
						op: "rename",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path, renameBody.to],
						precondition: {
							kind: "match",
							etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
						},
						payload_hash: renamePayload.payload_hash,
						size: renamePayload.size,
					},
					body: renameBody,
					key: IdempotencyKeySchema.parse("capacity-rename-0001"),
				});
				expect(await commitCommand(fixture, renameCommand)).toEqual({
					ok: false,
					failure: { kind: "capacity_exceeded" },
				});

				const restoreBody = { source_rev: 1, as_conflict_copy: false };
				const restoreBytes = JSON.stringify(restoreBody);
				const restorePayload = await prepareTextPayload(
					new TextEncoder().encode(restoreBytes),
				);
				const restoreCommand = FileCommandSchema.parse({
					op: "restore",
					intent: {
						op: "restore",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: {
							kind: "match",
							etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
						},
						payload_hash: restorePayload.payload_hash,
						size: restorePayload.size,
					},
					body: restoreBody,
					key: IdempotencyKeySchema.parse("capacity-restore-0001"),
				});
				expect(await commitCommand(fixture, restoreCommand)).toEqual({
					ok: false,
					failure: { kind: "capacity_exceeded" },
				});

				const after = captureTextStoreState(fixture.storage);
				expect(after.files).toEqual(before.files);
				expect(after.revisions).toEqual(before.revisions);
				expect(after.changes).toEqual(before.changes);
				expect(after.fts).toEqual(before.fts);
				expect(after.meta).toEqual(before.meta);
				expect(after.receipts).toEqual(before.receipts);
			},
			undefined,
			blobStore,
			capacityLimits,
		);
	});
});
