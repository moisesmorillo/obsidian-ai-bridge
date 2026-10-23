import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import { executeFileCommand } from "@worker/application/history";
import { prepareTextPayload } from "@worker/application/text-payload";
import type { TextStoreFixture } from "@worker/test-fixtures/text-files";
import {
	captureTextStoreState,
	seedLiveTextState,
	TEXT_FIXTURE_CONTEXT,
	TEXT_FIXTURE_EPOCH,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Build one validated inline PUT intent from exact test text. */
async function putIntent(
	path: string,
	content: string,
	precondition: { kind: "absent" } | { kind: "match"; etag: string },
) {
	const payload = await prepareTextPayload(new TextEncoder().encode(content));
	return TextMutationIntentSchema.parse({
		op: "put",
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [path],
		precondition,
		payload_hash: payload.payload_hash,
		size: payload.size,
	});
}

/** Hash UTF-8 text bytes without using the payload-preparation size guard. */
async function hashTextBytes(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Reserve and bind a real native ticket so callers can inspect state before commit. */
async function authorizeMutation(
	fixture: TextStoreFixture,
	intent: ReturnType<typeof TextMutationIntentSchema.parse>,
	key: string,
	context: AuthorizationContext = TEXT_FIXTURE_CONTEXT,
) {
	const idempotencyKey = IdempotencyKeySchema.parse(key);
	const descriptor = {
		op: intent.op,
		epoch: intent.epoch,
		paths: intent.paths,
		precondition: intent.precondition,
	};
	const lease = await fixture.store.beginMutation(
		context,
		descriptor,
		idempotencyKey,
	);
	if (!lease.ok) throw new Error(`Begin failed: ${lease.failure.kind}`);
	const admission = await fixture.admissions.authorize(
		context,
		intent,
		lease.lease.admission_id,
	);
	if (!admission.ok)
		throw new Error(`Authorize failed: ${admission.failure.kind}`);
	return { ticketId: admission.ticket.id, idempotencyKey };
}

/** Reserve, bind, and atomically commit one real native text mutation. */
async function commitMutation(
	fixture: TextStoreFixture,
	intent: ReturnType<typeof TextMutationIntentSchema.parse>,
	content: string | undefined,
	key: string,
	context: AuthorizationContext = TEXT_FIXTURE_CONTEXT,
) {
	const authorized = await authorizeMutation(fixture, intent, key, context);
	return fixture.store.commitText(
		context,
		intent,
		authorized.ticketId,
		content,
		authorized.idempotencyKey,
	);
}

describe("native conditional text storage", () => {
	it("counts deterministic UTF-8 payloads for Unicode and nullable row fields", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/été.md";
			const content = "café🙂\u0000";
			const intent = await putIntent(path, content, { kind: "absent" });
			const result = await commitMutation(
				fixture,
				intent,
				content,
				"logical-byte-key-01",
			);
			expect(result.ok).toBe(true);
			const encoder = new TextEncoder();
			const revision = fixture.storage.sql
				.exec<{ hash: string; size: number; origin: string; at: number }>(
					"SELECT hash, size, origin, at FROM revisions WHERE path = ?",
					path,
				)
				.toArray()[0];
			const receipt = fixture.storage.sql
				.exec<{
					client_id: string;
					key: string;
					fingerprint: string;
					status: number;
					body: string;
					at: number;
				}>("SELECT client_id, key, fingerprint, status, body, at FROM receipts")
				.toArray()[0];
			expect(revision).toBeDefined();
			expect(receipt).toBeDefined();
			const expected = {
				revisions: encoder.encode(
					JSON.stringify([
						path,
						1,
						revision?.hash,
						revision?.size,
						"text",
						content,
						null,
						0,
						revision?.origin,
						revision?.at,
					]),
				).byteLength,
				receipts: encoder.encode(
					JSON.stringify([
						receipt?.client_id,
						receipt?.key,
						receipt?.fingerprint,
						receipt?.status,
						receipt?.body,
						receipt?.at,
					]),
				).byteLength,
				changes: encoder.encode(
					JSON.stringify([
						1,
						"put",
						path,
						1,
						revision?.hash,
						null,
						null,
						TEXT_FIXTURE_CONTEXT.client_id,
						10_000,
					]),
				).byteLength,
			};
			const counters = Object.fromEntries(
				fixture.storage.sql
					.exec<{ key: string; value: string }>(
						"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
					)
					.toArray()
					.map(({ key, value }) => [key, Number(value)]),
			);
			expect(counters).toEqual({
				history_changes_bytes: expected.changes,
				history_pressure_bytes:
					expected.revisions + expected.receipts + expected.changes,
				history_receipts_bytes: expected.receipts,
				history_revisions_bytes: expected.revisions,
			});
		});
	});

	it("serializes competing creates for the final configured live-file slot", async () => {
		const limits = {
			databaseAlertBytes: 1_500_000_000,
			databaseLimitBytes: 2_000_000_000,
			liveFileLimit: 1,
			historyPressureLimitBytes: 1_000_000_000,
			blobAlertBytes: 4_000_000_000,
		};
		await withTextStore(
			async (fixture) => {
				const results = await Promise.all([
					commitMutation(
						fixture,
						await putIntent("notes/competitor-a.md", "a", { kind: "absent" }),
						"a",
						"last-slot-a-0001",
					),
					commitMutation(
						fixture,
						await putIntent("notes/competitor-b.md", "b", { kind: "absent" }),
						"b",
						"last-slot-b-0001",
					),
				]);
				expect(results.filter((result) => result.ok)).toHaveLength(1);
				expect(results.filter((result) => !result.ok)).toEqual([
					{ ok: false, failure: { kind: "capacity_exceeded" } },
				]);
			},
			undefined,
			undefined,
			limits,
		);
	});

	it("admits the 10,000th live file and keeps replay and delete available at capacity", async () => {
		await withTextStore(async (fixture) => {
			fixture.storage.transactionSync(() => {
				for (let index = 0; index < 9_999; index += 1) {
					const path = `seed/${index}.txt`;
					fixture.storage.sql.exec(
						"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 0, '', 0, 'text', NULL, 0, 10000, 'seed')",
						path,
						path,
					);
				}
				fixture.storage.sql.exec(
					"UPDATE meta SET value = '9999' WHERE key = 'live_file_count'",
				);
			});
			const path = "notes/last-slot.md";
			const content = "last slot";
			const intent = await putIntent(path, content, { kind: "absent" });
			const authorized = await authorizeMutation(
				fixture,
				intent,
				"last-file-slot-01",
			);
			const first = await fixture.store.commitText(
				TEXT_FIXTURE_CONTEXT,
				intent,
				authorized.ticketId,
				content,
				authorized.idempotencyKey,
			);
			expect(first).toMatchObject({ ok: true, response: { status: 201 } });
			const countersBeforeReplay = fixture.storage.sql
				.exec(
					"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
				)
				.toArray();
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					authorized.ticketId,
					content,
					authorized.idempotencyKey,
				),
			).toEqual(first);
			expect(
				fixture.storage.sql
					.exec(
						"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
					)
					.toArray(),
			).toEqual(countersBeforeReplay);
			expect(
				await commitMutation(
					fixture,
					await putIntent("notes/over-limit.md", "x", { kind: "absent" }),
					"x",
					"over-file-limit-1",
				),
			).toEqual({ ok: false, failure: { kind: "capacity_exceeded" } });
			expect(
				await commitMutation(
					fixture,
					await putIntent(path, "updated", {
						kind: "match",
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					}),
					"updated",
					"over-file-limit-2",
				),
			).toEqual({ ok: false, failure: { kind: "capacity_exceeded" } });
			const deletion = TextMutationIntentSchema.parse({
				op: "delete",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			expect(
				await commitMutation(fixture, deletion, undefined, "delete-at-cap-01"),
			).toMatchObject({ ok: true, response: { body: { deleted: true } } });
		});
	});

	it("rolls back every publication row when real native growth crosses a small database limit", async () => {
		const limits = {
			databaseAlertBytes: 1,
			databaseLimitBytes: Number.MAX_SAFE_INTEGER,
			liveFileLimit: 10_000,
			historyPressureLimitBytes: 1,
			blobAlertBytes: 1,
		};
		await withTextStore(
			async (fixture) => {
				const databaseBytes = fixture.storage.sql.databaseSize;
				const cap = databaseBytes + 8_192;
				limits.databaseLimitBytes = cap;
				const path = "notes/native-growth.md";
				const content = "growth-λ🙂".repeat(4_000);
				const intent = await putIntent(path, content, { kind: "absent" });
				const authorized = await authorizeMutation(
					fixture,
					intent,
					"native-growth-key-01",
				);
				const before = captureTextStoreState(fixture.storage);
				const beforeBytes = fixture.storage.sql.databaseSize;
				const result = await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					authorized.ticketId,
					content,
					authorized.idempotencyKey,
				);
				expect(result).toEqual({
					ok: false,
					failure: { kind: "capacity_exceeded" },
				});
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
				expect(fixture.storage.sql.databaseSize).toBe(beforeBytes);
			},
			undefined,
			undefined,
			limits,
		);
	});

	it("renames a live text file with one feed row and retained source history", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/before.md";
			const destination = "notes/after.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "original",
			});
			const body = { to: destination };
			const command = {
				op: "rename" as const,
				intent: {
					op: "rename" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [source, destination],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
					payload_hash: await hashTextBytes(JSON.stringify(body)),
					size: new TextEncoder().encode(JSON.stringify(body)).byteLength,
				},
				body,
			};
			const descriptor = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: command.intent.precondition,
			};
			const reservation = await fixture.coordinator.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				descriptor,
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
			const result = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				command,
			);
			expect(result).toMatchObject({
				ok: true,
				response: { body: { path: destination, seq: 2 } },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT path, rev, deleted FROM files ORDER BY path")
					.toArray(),
			).toEqual([
				{ path: destination, rev: 1, deleted: 0 },
				{ path: source, rev: 2, deleted: 1 },
			]);
			expect(
				fixture.storage.sql
					.exec(
						"SELECT seq, op, path, from_path, from_rev FROM changes ORDER BY seq",
					)
					.toArray(),
			).toEqual([
				{ seq: 1, op: "put", path: source, from_path: null, from_rev: null },
				{
					seq: 2,
					op: "rename",
					path: destination,
					from_path: source,
					from_rev: 2,
				},
			]);
			const historical = await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
				path: source,
				epoch: TEXT_FIXTURE_EPOCH,
				rev: 1,
			});
			expect(historical).toMatchObject({
				ok: true,
				body: { content: "original" },
			});
		});
	});
	it("appends exact UTF-8 input to the authorized live text revision", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append.md";
			await seedLiveTextState(fixture.storage, {
				path,
				content: "A\uFEFF\u0000",
			});
			const command = {
				op: "append" as const,
				intent: {
					op: "append" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: { kind: "none" as const },
					payload_hash: await hashTextBytes("é"),
					size: new TextEncoder().encode("é").byteLength,
				},
				content: "é",
				key: IdempotencyKeySchema.parse("append-key-0001"),
			};
			const descriptor = {
				op: "append" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: { kind: "none" as const },
			};
			const reservation = await fixture.coordinator.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				descriptor,
				command.key,
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
			const result = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				command,
			);
			expect(result).toMatchObject({ ok: true });
			expect(
				fixture.storage.sql
					.exec("SELECT content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "A\uFEFF\u0000é" }]);
		});
	});
	it("admits binary mutations and rejects append from authoritative state", async () => {
		await withTextStore(async (fixture) => {
			const unsupportedIntent = TextMutationIntentSchema.parse({
				op: "put",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: ["notes/page.md"],
				precondition: { kind: "absent" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			expect(Reflect.set(unsupportedIntent, "op", "append")).toBe(true);
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					unsupportedIntent,
					"unused-ticket",
					undefined,
				),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(
				await fixture.store.beginMutation(TEXT_FIXTURE_CONTEXT, {
					op: "put",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["archive/data.bin"],
					precondition: { kind: "absent" },
				}),
			).toMatchObject({ ok: true });
			const before = captureTextStoreState(fixture.storage);
			const command = FileCommandSchema.parse({
				op: "append",
				intent: {
					op: "append",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["archive/data.bin"],
					precondition: { kind: "none" },
					payload_hash: EMPTY_PAYLOAD_HASH,
					size: 0,
				},
				content: "",
				key: "binary-append-key-01",
			});
			const gateway = {
				beginMutation: fixture.store.beginMutation.bind(fixture.store),
				beginRenameSource: fixture.store.beginRenameSource.bind(fixture.store),
				authorize: fixture.admissions.authorize.bind(fixture.admissions),
				authorizeRenameSource: fixture.admissions.authorizeRenameSource.bind(
					fixture.admissions,
				),
				commitFileCommand: fixture.store.commitFileCommand.bind(fixture.store),
				finishAdmission: fixture.admissions.finish.bind(fixture.admissions),
				readHistory: fixture.store.readHistory.bind(fixture.store),
			};
			let bodyReads = 0;
			const result = await executeFileCommand(
				gateway,
				TEXT_FIXTURE_CONTEXT,
				{
					op: "append",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["archive/data.bin"],
					precondition: { kind: "none" },
				},
				command.key,
				async () => {
					bodyReads++;
					return command;
				},
			);
			expect(result).toEqual({ ok: false, failure: { kind: "not_found" } });
			expect(bodyReads).toBe(1);
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
			expect(
				await fixture.store.beginMutation(TEXT_FIXTURE_CONTEXT, {
					op: "delete",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["archive/data.bin"],
					precondition: {
						kind: "match",
						etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					},
				}),
			).toMatchObject({ ok: true });
		});
	});
	it("publishes create, update, delete, and recreate as exact per-path revisions", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/native.md";
			const first = await commitMutation(
				fixture,
				await putIntent(path, "first", { kind: "absent" }),
				"first",
				"text-key-0001",
			);
			expect(first).toMatchObject({
				ok: true,
				response: {
					status: 201,
					body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 1), seq: 1, size: 5 },
				},
			});
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT origin, updated_at FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([
				{ origin: TEXT_FIXTURE_CONTEXT.client_id, updated_at: 10_000 },
			]);
			const second = await commitMutation(
				fixture,
				await putIntent(path, "second", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
				"second",
				"text-key-0002",
			);
			expect(second).toMatchObject({
				ok: true,
				response: {
					status: 200,
					body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 2), seq: 2, size: 6 },
				},
			});
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files_fts")
					.toArray(),
			).toEqual([{ path, content: "second" }]);
			const deletion = TextMutationIntentSchema.parse({
				op: "delete",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
				},
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			const third = await commitMutation(
				fixture,
				deletion,
				undefined,
				"text-key-0003",
			);
			expect(third).toMatchObject({
				ok: true,
				response: {
					status: 200,
					body: {
						etag: formatETag(TEXT_FIXTURE_EPOCH, 3),
						seq: 3,
						deleted: true,
					},
				},
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, { path }),
			).toMatchObject({
				ok: true,
				body: { deleted: true, content: null, hash: "", size: 0 },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "0" }]);
			expect(
				fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
			).toEqual([]);
			const fourth = await commitMutation(
				fixture,
				await putIntent(path, "fourth", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 3),
				}),
				"fourth",
				"text-key-0004",
			);
			expect(fourth).toMatchObject({
				ok: true,
				response: {
					status: 201,
					body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 4), seq: 4 },
				},
			});
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT rev, content, deleted FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ rev: 4, content: "fourth", deleted: 0 }]);
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, content, deleted FROM revisions WHERE path = ? ORDER BY rev",
						path,
					)
					.toArray(),
			).toEqual([
				{ rev: 1, content: "first", deleted: 0 },
				{ rev: 2, content: "second", deleted: 0 },
				{ rev: 3, content: null, deleted: 1 },
				{ rev: 4, content: "fourth", deleted: 0 },
			]);
			expect(
				fixture.storage.sql
					.exec("SELECT seq FROM changes ORDER BY seq")
					.toArray(),
			).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'head_seq'")
					.toArray(),
			).toEqual([{ value: "4" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			expect(
				fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
			).toEqual([{ path }]);
		});
	});

	it("reads selected historical bytes and reports missing current paths", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/history.md";
			await commitMutation(
				fixture,
				await putIntent(path, "old text", { kind: "absent" }),
				"old text",
				"history-key-001",
			);
			await commitMutation(
				fixture,
				await putIntent(path, "new text", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
				"new text",
				"history-key-002",
			);
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, { path, rev: 1 }),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					epoch: TEXT_FIXTURE_EPOCH,
					rev: 1,
				}),
			).toMatchObject({
				ok: true,
				body: {
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					content: "old text",
					offset: 0,
					length: 8,
					truncated: false,
				},
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path: "missing.md",
				}),
			).toEqual({ ok: false, failure: { kind: "not_found" } });
		});
	});

	it("AC-38 server: keeps receipts independent when clients share an idempotency key", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/replay.md";
			const originalIntent = await putIntent(path, "original", {
				kind: "absent",
			});
			const original = await commitMutation(
				fixture,
				originalIntent,
				"original",
				"replay-key-001",
			);
			await commitMutation(
				fixture,
				await putIntent(path, "later", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
				"later",
				"replay-key-002",
			);
			const retry = await commitMutation(
				fixture,
				originalIntent,
				"original",
				"replay-key-001",
			);
			expect(retry).toEqual(original);
			const changedRetry = await commitMutation(
				fixture,
				await putIntent(path, "changed", { kind: "absent" }),
				"changed",
				"replay-key-001",
			);
			expect(changedRetry).toEqual({
				ok: false,
				failure: { kind: "idempotency_mismatch" },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT rev FROM revisions WHERE path = ? ORDER BY rev", path)
					.toArray(),
			).toEqual([{ rev: 1 }, { rev: 2 }]);
			expect(
				fixture.storage.sql
					.exec("SELECT COUNT(*) AS count FROM changes")
					.toArray(),
			).toEqual([{ count: 2 }]);
			const otherClient: AuthorizationContext = {
				client_id: "other-text-client",
				grant_id: "other-text-grant",
				scopes: TEXT_FIXTURE_CONTEXT.scopes,
			};
			const independent = await commitMutation(
				fixture,
				await putIntent("notes/other-client.md", "other", { kind: "absent" }),
				"other",
				"replay-key-001",
				otherClient,
			);
			expect(independent).toMatchObject({
				ok: true,
				response: { status: 201 },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT client_id, key FROM receipts ORDER BY client_id")
					.toArray(),
			).toEqual([
				{ client_id: "other-text-client", key: "replay-key-001" },
				{ client_id: "text-store-client", key: "replay-key-001" },
				{ client_id: "text-store-client", key: "replay-key-002" },
			]);
		});
	});

	it("rejects unsafe revision, head, sequence, and live-count growth without consuming ownership", async () => {
		const maximum = Number.MAX_SAFE_INTEGER;
		await withTextStore(async (fixture) => {
			const path = "notes/revision-limit.md";
			await seedLiveTextState(fixture.storage, {
				path,
				content: "stable",
				revision: maximum,
				sequence: 1,
			});
			const intent = await putIntent(path, "changed", {
				kind: "match",
				etag: formatETag(TEXT_FIXTURE_EPOCH, maximum),
			});
			const auth = await authorizeMutation(
				fixture,
				intent,
				"revision-limit-key",
			);
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					"changed",
					auth.idempotencyKey,
				),
			).rejects.toThrow("Unsafe text revision or sequence");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});

		await withTextStore(async (fixture) => {
			fixture.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'head_seq'",
				String(maximum),
			);
			const intent = await putIntent("notes/head-limit.md", "new", {
				kind: "absent",
			});
			const auth = await authorizeMutation(fixture, intent, "head-limit-key");
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					"new",
					auth.idempotencyKey,
				),
			).rejects.toThrow("Unsafe text revision or sequence");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});

		await withTextStore(async (fixture) => {
			await seedLiveTextState(fixture.storage, {
				path: "notes/sequence-limit.md",
				content: "stable",
				sequence: maximum,
			});
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '0' WHERE key = 'head_seq'",
			);
			const intent = await putIntent("notes/next-sequence.md", "new", {
				kind: "absent",
			});
			const auth = await authorizeMutation(
				fixture,
				intent,
				"sequence-limit-key",
			);
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					"new",
					auth.idempotencyKey,
				),
			).rejects.toThrow("Unsafe text change sequence");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});

		await withTextStore(async (fixture) => {
			fixture.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'live_file_count'",
				String(maximum),
			);
			const intent = await putIntent("notes/live-limit.md", "new", {
				kind: "absent",
			});
			const auth = await authorizeMutation(fixture, intent, "live-limit-key");
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					"new",
					auth.idempotencyKey,
				),
			).rejects.toThrow("Unsafe live file counter");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	});

	it("publishes the maximum safe revision and sequence", async () => {
		const maximum = Number.MAX_SAFE_INTEGER;
		await withTextStore(async (fixture) => {
			const path = "notes/safe-boundary.md";
			await seedLiveTextState(fixture.storage, {
				path,
				content: "before",
				revision: maximum - 1,
				sequence: maximum - 1,
			});
			fixture.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'live_file_count'",
				String(maximum - 1),
			);
			const intent = await putIntent(path, "after", {
				kind: "match",
				etag: formatETag(TEXT_FIXTURE_EPOCH, maximum - 1),
			});
			const result = await commitMutation(
				fixture,
				intent,
				"after",
				"safe-boundary-key",
			);
			expect(result).toMatchObject({
				ok: true,
				response: {
					body: { etag: formatETag(TEXT_FIXTURE_EPOCH, maximum), seq: maximum },
				},
			});
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'head_seq'")
					.toArray(),
			).toEqual([{ value: String(maximum) }]);
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: String(maximum - 1) }]);
		});
	});

	it("rejects text larger than the inline limit before publication", async () => {
		await withTextStore(async (fixture) => {
			const content = "\0".repeat(1_000_001);
			const intent = TextMutationIntentSchema.parse({
				op: "put",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: ["notes/overflow.md"],
				precondition: { kind: "absent" },
				payload_hash: await hashTextBytes(content),
				size: 1_000_001,
			});
			const auth = await authorizeMutation(
				fixture,
				intent,
				"inline-overflow-key",
			);
			const before = captureTextStoreState(fixture.storage);
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					content,
					auth.idempotencyKey,
				),
			).toEqual({ ok: false, failure: { kind: "text_too_large" } });
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	});

	it("accepts the maximum safe live-file counter", async () => {
		const maximum = Number.MAX_SAFE_INTEGER;
		await withTextStore(async (fixture) => {
			fixture.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'live_file_count'",
				String(maximum - 1),
			);
			const intent = await putIntent("notes/live-safe-boundary.md", "one", {
				kind: "absent",
			});
			const result = await commitMutation(
				fixture,
				intent,
				"one",
				"live-safe-boundary-key",
			);
			expect(result).toMatchObject({ ok: true, response: { status: 201 } });
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: String(maximum) }]);
		});
	});

	it("keeps a 1 MB NUL payload out of the compact success receipt", async () => {
		await withTextStore(async (fixture) => {
			const databaseBytesBefore = fixture.storage.sql.databaseSize;
			const content = "\0".repeat(1_000_000);
			const result = await commitMutation(
				fixture,
				await putIntent("notes/large.canvas", content, { kind: "absent" }),
				content,
				"large-nul-key-001",
			);
			expect(result).toMatchObject({
				ok: true,
				response: { status: 201, body: { size: 1_000_000 } },
			});
			const receipt = fixture.storage.sql
				.exec<{ body: string }>("SELECT body FROM receipts")
				.toArray()[0]?.body;
			expect(receipt).toBeDefined();
			expect(receipt?.length).toBeLessThan(512);
			expect(receipt).not.toContain("\0");
			expect(
				fixture.storage.sql
					.exec<{ size: number }>(
						"SELECT MAX(length(CAST(content AS BLOB))) AS size FROM revisions",
					)
					.toArray(),
			).toEqual([{ size: 1_000_000 }]);
			const databaseBytesAfter = fixture.storage.sql.databaseSize;
			expect(databaseBytesAfter).toBeGreaterThan(databaseBytesBefore);
			console.info(
				`text_store_measurements: db_bytes_before=${databaseBytesBefore} db_bytes_after=${databaseBytesAfter} db_growth=${databaseBytesAfter - databaseBytesBefore} largest_content_bytes=1000000 receipt_body_bytes=${new TextEncoder().encode(receipt ?? "").byteLength}`,
			);
		});
	});

	it("preserves BOM and non-ASCII text, keeps Canvas out of FTS, and slices UTF-16 ranges", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/emoji.canvas";
			const content = "\uFEFFcafé😀";
			const result = await commitMutation(
				fixture,
				await putIntent(path, content, { kind: "absent" }),
				content,
				"canvas-key-0001",
			);
			expect(result).toMatchObject({
				ok: true,
				response: { body: { size: 12 } },
			});
			expect(
				fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
			).toEqual([]);
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, { path }),
			).toMatchObject({ ok: true, body: { content, truncated: false } });
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					offset: 5,
					length: 1,
				}),
			).toMatchObject({
				ok: true,
				body: { content: "\ud83d", offset: 5, length: 1, truncated: true },
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					offset: 2,
					length: 0,
				}),
			).toMatchObject({
				ok: true,
				body: { content: "", offset: 2, length: 0, truncated: true },
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					offset: -1,
				}),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					offset: 3,
					length: 99,
				}),
			).toMatchObject({
				ok: true,
				body: { content: "fé😀", offset: 3, length: 4, truncated: true },
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					offset: 99,
					length: 8,
				}),
			).toMatchObject({
				ok: true,
				body: { content: "", offset: 99, length: 0, truncated: true },
			});
			expect(
				await fixture.store.readText(TEXT_FIXTURE_CONTEXT, {
					path,
					rev: 9,
					epoch: TEXT_FIXTURE_EPOCH,
				}),
			).toEqual({ ok: false, failure: { kind: "revision_pruned" } });
		});
	});

	it("rejects caller payload identity that does not match supplied text", async () => {
		await withTextStore(async (fixture) => {
			const intent = await putIntent("notes/tamper.md", "authoritative", {
				kind: "absent",
			});
			const key = IdempotencyKeySchema.parse("payload-key-001");
			const lease = await fixture.store.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				{
					op: intent.op,
					epoch: intent.epoch,
					paths: intent.paths,
					precondition: intent.precondition,
				},
				key,
			);
			expect(lease.ok).toBe(true);
			if (!lease.ok) return;
			const ticket = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				intent,
				lease.lease.admission_id,
			);
			expect(ticket.ok).toBe(true);
			if (!ticket.ok) return;
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					ticket.ticket.id,
					"tampered",
					key,
				),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(
				fixture.storage.sql
					.exec("SELECT COUNT(*) AS count FROM files")
					.toArray(),
			).toEqual([{ count: 0 }]);
			expect(
				fixture.storage.sql
					.exec("SELECT COUNT(*) AS count FROM operation_admissions")
					.toArray(),
			).toEqual([{ count: 1 }]);
		});
	});

	it("rolls back all publication stages when native SQL rejects each staged write", async () => {
		/** Native trigger boundaries for rollback checks after each publication table write. */
		const stages = [
			[
				"feed",
				"CREATE TRIGGER reject_feed AFTER INSERT ON changes BEGIN SELECT RAISE(ABORT, 'feed failure'); END",
				"feed failure",
			],
			[
				"file",
				"CREATE TRIGGER reject_file AFTER INSERT ON files BEGIN SELECT RAISE(ABORT, 'file failure'); END",
				"file failure",
			],
			[
				"history",
				"CREATE TRIGGER reject_history AFTER INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'history failure'); END",
				"history failure",
			],
			[
				"receipt",
				"CREATE TRIGGER reject_receipt AFTER INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
				"receipt failure",
			],
			[
				"counter",
				"CREATE TRIGGER reject_counter AFTER UPDATE ON meta WHEN OLD.key = 'head_seq' BEGIN SELECT RAISE(ABORT, 'counter failure'); END",
				"counter failure",
			],
		] as const;
		/** Closed table queries that confirm each injected failure left no published state. */
		const stateQueries = [
			["files", "SELECT COUNT(*) AS count FROM files"],
			["revisions", "SELECT COUNT(*) AS count FROM revisions"],
			["changes", "SELECT COUNT(*) AS count FROM changes"],
			["receipts", "SELECT COUNT(*) AS count FROM receipts"],
			["FTS", "SELECT COUNT(*) AS count FROM files_fts"],
		] as const;
		for (const [stage, triggerSql, failure] of stages) {
			await withTextStore(async (fixture) => {
				fixture.storage.sql.exec(triggerSql);
				await expect(
					commitMutation(
						fixture,
						await putIntent("notes/rollback.md", stage, { kind: "absent" }),
						stage,
						`rollback-${stage}-key`,
					),
				).rejects.toThrow(failure);
				for (const [name, query] of stateQueries)
					expect(
						fixture.storage.sql.exec(query).toArray(),
						`${stage} rollback for ${name}`,
					).toEqual([{ count: 0 }]);
				expect(
					fixture.storage.sql
						.exec(
							"SELECT value FROM meta WHERE key IN ('head_seq', 'live_file_count') ORDER BY key",
						)
						.toArray(),
				).toEqual([{ value: "0" }, { value: "0" }]);
				expect(
					fixture.storage.sql
						.exec("SELECT COUNT(*) AS count FROM operation_admissions")
						.toArray(),
				).toEqual([{ count: 1 }]);
				expect(
					fixture.storage.sql
						.exec("SELECT COUNT(*) AS count FROM mutation_claims")
						.toArray(),
				).toEqual([{ count: 1 }]);
			});
		}
	});

	it("restores complete seeded state after UPDATE and DELETE publication failures", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/rollback-update.md";
			await seedLiveTextState(fixture.storage, { path, content: "before" });
			fixture.storage.sql.exec(
				"CREATE TRIGGER reject_update_receipt AFTER INSERT ON receipts WHEN NEW.client_id = 'text-store-client' BEGIN SELECT RAISE(ABORT, 'update receipt failure'); END",
			);
			const intent = await putIntent(path, "after", {
				kind: "match",
				etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
			});
			const auth = await authorizeMutation(
				fixture,
				intent,
				"update-rollback-key",
			);
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					"after",
					auth.idempotencyKey,
				),
			).rejects.toThrow("update receipt failure");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});

		await withTextStore(async (fixture) => {
			const path = "notes/rollback-delete.md";
			await seedLiveTextState(fixture.storage, { path, content: "before" });
			fixture.storage.sql.exec(
				"CREATE TRIGGER reject_delete_counter AFTER UPDATE ON meta WHEN OLD.key = 'live_file_count' BEGIN SELECT RAISE(ABORT, 'delete counter failure'); END",
			);
			const intent = TextMutationIntentSchema.parse({
				op: "delete",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			const auth = await authorizeMutation(
				fixture,
				intent,
				"delete-rollback-key",
			);
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					intent,
					auth.ticketId,
					undefined,
					auth.idempotencyKey,
				),
			).rejects.toThrow("delete counter failure");
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	});

	it("keeps a tombstone and live canonical alias visible when recreation collides", async () => {
		await withTextStore(async (fixture) => {
			const tombstonePath = "notes/CAFÉ.md";
			await commitMutation(
				fixture,
				await putIntent(tombstonePath, "old", { kind: "absent" }),
				"old",
				"alias-key-001",
			);
			const deletion = TextMutationIntentSchema.parse({
				op: "delete",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [tombstonePath],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			await commitMutation(fixture, deletion, undefined, "alias-key-002");
			await commitMutation(
				fixture,
				await putIntent("notes/café.md", "alias", { kind: "absent" }),
				"alias",
				"alias-key-003",
			);
			const collision = await commitMutation(
				fixture,
				await putIntent(tombstonePath, "new", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
				}),
				"new",
				"alias-key-004",
			);
			expect(collision).toEqual({
				ok: false,
				failure: { kind: "path_collision", existing_path: "notes/café.md" },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT path, rev, content, deleted FROM files ORDER BY path")
					.toArray(),
			).toEqual([
				{ path: "notes/CAFÉ.md", rev: 2, content: null, deleted: 1 },
				{ path: "notes/café.md", rev: 1, content: "alias", deleted: 0 },
			]);
		});
	});

	it("returns read-authorized current precondition content but omits it for write-only clients", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/precondition.md";
			await commitMutation(
				fixture,
				await putIntent(path, "current", { kind: "absent" }),
				"current",
				"condition-key-01",
			);
			await commitMutation(
				fixture,
				await putIntent(path, "later", {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
				"later",
				"condition-key-02",
			);
			const intent = await putIntent(path, "attempt", {
				kind: "match",
				etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
			});
			const writeOnly: AuthorizationContext = {
				client_id: "text-store-client",
				grant_id: "text-store-grant",
				scopes: ["vault:write"],
			};
			const writeResult = await commitMutation(
				fixture,
				intent,
				"attempt",
				"condition-key-03",
				writeOnly,
			);
			expect(writeResult).toMatchObject({
				ok: false,
				failure: {
					kind: "precondition_failed",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
				},
			});
			if (!writeResult.ok && writeResult.failure.kind === "precondition_failed")
				expect("content" in writeResult.failure).toBe(false);
			const readWrite: AuthorizationContext = {
				...writeOnly,
				scopes: ["vault:read", "vault:write"],
			};
			const readResult = await commitMutation(
				fixture,
				intent,
				"attempt",
				"condition-key-04",
				readWrite,
			);
			expect(readResult).toMatchObject({
				ok: false,
				failure: {
					kind: "precondition_failed",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
					content: "later",
				},
			});
			expect(
				fixture.storage.sql
					.exec("SELECT rev, content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ rev: 2, content: "later" }]);
			const staleEpoch = "fedcba9876543210fedcba9876543210";
			const currentIntent = await putIntent(path, "attempt", {
				kind: "match",
				etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
			});
			const stale = TextMutationIntentSchema.parse({
				...currentIntent,
				epoch: staleEpoch,
				precondition: { kind: "match", etag: formatETag(staleEpoch, 2) },
			});
			expect(
				await fixture.store.beginMutation(
					readWrite,
					{
						op: stale.op,
						epoch: stale.epoch,
						paths: stale.paths,
						precondition: stale.precondition,
					},
					IdempotencyKeySchema.parse("stale-epoch-001"),
				),
			).toEqual({
				ok: false,
				failure: { kind: "epoch_mismatch", current_epoch: TEXT_FIXTURE_EPOCH },
			});
		});
	});
});
