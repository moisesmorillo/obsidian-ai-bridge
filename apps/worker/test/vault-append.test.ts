import {
	EMPTY_PAYLOAD_HASH,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	OperationIntentSchema,
	RenameReservationSchema,
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
import { describe, expect, it, vi } from "vitest";

/** Hash exact appended UTF-8 bytes for the command's canonical operation identity. */
async function hashBytes(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Build a canonical append command with exact input digest and size. */
async function appendCommand(path: string, content: string, rawKey: string) {
	return {
		op: "append" as const,
		intent: {
			op: "append" as const,
			epoch: TEXT_FIXTURE_EPOCH,
			paths: [path],
			precondition: { kind: "none" as const },
			payload_hash: await hashBytes(content),
			size: new TextEncoder().encode(content).byteLength,
		},
		content,
		key: IdempotencyKeySchema.parse(rawKey),
	};
}

/** Reserve and authorize an append through the native admission owner. */
async function authorizeAppend(
	fixture: TextStoreFixture,
	command: Awaited<ReturnType<typeof appendCommand>>,
): Promise<string> {
	const reservation = await fixture.coordinator.beginMutation(
		TEXT_FIXTURE_CONTEXT,
		{
			op: "append",
			epoch: command.intent.epoch,
			paths: command.intent.paths,
			precondition: command.intent.precondition,
		},
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
	return admission.ticket.id;
}

/** Build an exact native PUT intent for an append-interleaving test. */
async function putIntentForRace(path: string, content: string) {
	const payload = await prepareTextPayload(new TextEncoder().encode(content));
	return TextMutationIntentSchema.parse({
		op: "put",
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [path],
		precondition: { kind: "match", etag: formatETag(TEXT_FIXTURE_EPOCH, 1) },
		payload_hash: payload.payload_hash,
		size: payload.size,
	});
}

/** Reserve and authorize one PUT before the append candidate digest starts. */
async function authorizePutForRace(
	fixture: TextStoreFixture,
	intent: Awaited<ReturnType<typeof putIntentForRace>>,
	rawKey: string,
) {
	const key = IdempotencyKeySchema.parse(rawKey);
	const reservation = await fixture.coordinator.beginMutation(
		TEXT_FIXTURE_CONTEXT,
		{
			op: "put",
			epoch: intent.epoch,
			paths: intent.paths,
			precondition: intent.precondition,
		},
		key,
	);
	if (!reservation.ok)
		throw new Error(`PUT reservation failed: ${reservation.failure.kind}`);
	const admission = await fixture.admissions.authorize(
		TEXT_FIXTURE_CONTEXT,
		intent,
		reservation.lease.admission_id,
	);
	if (!admission.ok)
		throw new Error(`PUT authorization failed: ${admission.failure.kind}`);
	return admission.ticket.id;
}

describe("native append commands", () => {
	it("retries a candidate after two real native append commits interleave", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/interleaved-append.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const first = await appendCommand(path, "x", "append-race-key-01");
			const second = await appendCommand(path, "y", "append-race-key-02");
			const firstTicket = await authorizeAppend(fixture, first);
			const secondTicket = await authorizeAppend(fixture, second);
			let arrivals = 0;
			/** Release both candidates after each reads the same source text. */
			let release = () => {};
			const barrier = new Promise<void>((resolve) => {
				release = resolve;
			});
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					const candidate = new TextDecoder().decode(data);
					if (
						(candidate === "basex" || candidate === "basey") &&
						arrivals < 2
					) {
						arrivals += 1;
						if (arrivals === 2) release();
						await barrier;
					}
					return digest(algorithm, data);
				});
			let results: Awaited<
				ReturnType<typeof fixture.store.commitFileCommand>
			>[];
			try {
				results = await Promise.all([
					fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						first.intent,
						firstTicket,
						first,
						first.key,
					),
					fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						second.intent,
						secondTicket,
						second,
						second.key,
					),
				]);
			} finally {
				spy.mockRestore();
			}
			expect(results.every((result) => result.ok)).toBe(true);
			const current = fixture.storage.sql
				.exec("SELECT rev, content FROM files WHERE path = ?", path)
				.toArray();
			expect(current).toHaveLength(1);
			expect(["basexy", "baseyx"]).toContain(current[0].content);
			expect(current[0].rev).toBe(3);
			expect(
				fixture.storage.sql
					.exec(
						"SELECT content FROM revisions WHERE path = ? ORDER BY rev",
						path,
					)
					.toArray(),
			).toHaveLength(3);
		});
	});
	it("requires an idempotency key before reading an append command", async () => {
		await withTextStore(async (fixture) => {
			const readCommand = vi.fn(async () => {
				throw new Error("body must not be read");
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
			const descriptor = {
				op: "append" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: ["notes/missing-key.md"],
				precondition: { kind: "none" as const },
			};
			expect(
				await fixture.store.beginMutation(TEXT_FIXTURE_CONTEXT, descriptor),
			).toEqual({ ok: false, failure: { kind: "idempotency_key_required" } });
			const result = await executeFileCommand(
				gateway,
				TEXT_FIXTURE_CONTEXT,
				descriptor,
				undefined,
				readCommand,
			);
			expect(result).toEqual({
				ok: false,
				failure: { kind: "idempotency_key_required" },
			});
			expect(readCommand).not.toHaveBeenCalled();
		});
	});

	it("retains an uncertain admission when a commit RPC fails", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/uncertain-append.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const command = await appendCommand(path, "x", "append-uncertain-key");
			const gateway = {
				beginMutation: fixture.store.beginMutation.bind(fixture.store),
				beginRenameSource: fixture.store.beginRenameSource.bind(fixture.store),
				authorize: fixture.admissions.authorize.bind(fixture.admissions),
				authorizeRenameSource: fixture.admissions.authorizeRenameSource.bind(
					fixture.admissions,
				),
				commitFileCommand: async () => {
					throw new Error("unknown commit RPC result");
				},
				finishAdmission: fixture.admissions.finish.bind(fixture.admissions),
				readHistory: fixture.store.readHistory.bind(fixture.store),
			};
			await expect(
				executeFileCommand(
					gateway,
					TEXT_FIXTURE_CONTEXT,
					{
						op: "append",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: { kind: "none" },
					},
					command.key,
					async () => command,
				),
			).rejects.toThrow("unknown commit RPC result");
			expect(
				fixture.storage.sql
					.exec("SELECT state FROM operation_admissions ORDER BY state")
					.toArray(),
			).toEqual([{ state: "uncertain" }, { state: "uncertain" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "base" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT key FROM mutation_claims WHERE key = ?", command.key)
					.toArray(),
			).toEqual([{ key: command.key }]);
		});
	});

	it("replays a lost response without appending the same input twice", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/replay-append.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const content = "é";
			const key = IdempotencyKeySchema.parse("append-replay-key-01");
			const command = {
				op: "append" as const,
				intent: {
					op: "append" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: { kind: "none" as const },
					payload_hash: await hashBytes(content),
					size: new TextEncoder().encode(content).byteLength,
				},
				content,
				key,
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
			const first = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				command,
			);
			const replay = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				command,
			);
			expect(replay).toEqual(first);
			expect(
				fixture.storage.sql
					.exec("SELECT rev, content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ rev: 2, content: "baseé" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT seq, op FROM changes ORDER BY seq")
					.toArray(),
			).toEqual([
				{ seq: 1, op: "put" },
				{ seq: 2, op: "put" },
			]);
		});
	});

	it("accepts an exact one-million-byte result across a multibyte boundary", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-limit.md";
			await seedLiveTextState(fixture.storage, {
				path,
				content: "x".repeat(999_998),
			});
			const command = await appendCommand(path, "é", "append-limit-key-01");
			const ticket = await authorizeAppend(fixture, command);
			const result = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				ticket,
				command,
				command.key,
			);
			expect(result).toMatchObject({
				ok: true,
				response: {
					body: { size: 1_000_000, etag: formatETag(TEXT_FIXTURE_EPOCH, 2) },
				},
			});
			expect(
				fixture.storage.sql
					.exec(
						"SELECT length(content) AS length FROM files WHERE path = ?",
						path,
					)
					.toArray(),
			).toEqual([{ length: 999_999 }]);
		});
	}, 20_000);

	it("keeps an empty append as one exact revision", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/empty-append.md";
			await seedLiveTextState(fixture.storage, { path, content: "same" });
			const command = await appendCommand(path, "", "append-empty-key-001");
			const ticket = await authorizeAppend(fixture, command);
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					command.intent,
					ticket,
					command,
					command.key,
				),
			).toMatchObject({
				ok: true,
				response: {
					body: { size: 4, etag: formatETag(TEXT_FIXTURE_EPOCH, 2) },
				},
			});
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, content FROM revisions WHERE path = ? ORDER BY rev",
						path,
					)
					.toArray(),
			).toEqual([
				{ rev: 1, content: "same" },
				{ rev: 2, content: "same" },
			]);
		});
	});

	it("rejects a one-byte oversized result without consuming publication state", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-over-limit.md";
			await seedLiveTextState(fixture.storage, { path, content: "a" });
			const command = await appendCommand(
				path,
				"x".repeat(1_000_000),
				"append-over-key-001",
			);
			const ticket = await authorizeAppend(fixture, command);
			const before = captureTextStoreState(fixture.storage);
			const result = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				ticket,
				command,
				command.key,
			);
			expect(result).toEqual({
				ok: false,
				failure: { kind: "text_too_large" },
			});
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	}, 20_000);

	it("rebuilds an append candidate after an intervening native PUT", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-put-race.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const append = await appendCommand(path, "x", "append-put-race-key");
			const appendTicket = await authorizeAppend(fixture, append);
			const putIntent = await putIntentForRace(path, "changed");
			const putTicket = await authorizePutForRace(
				fixture,
				putIntent,
				"append-put-race-put-key",
			);
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let changed = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!changed && new TextDecoder().decode(data) === "basex") {
						changed = true;
						expect(
							await fixture.store.commitText(
								TEXT_FIXTURE_CONTEXT,
								putIntent,
								putTicket,
								"changed",
								IdempotencyKeySchema.parse("append-put-race-put-key"),
							),
						).toMatchObject({ ok: true });
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						append.intent,
						appendTicket,
						append,
						append.key,
					),
				).toMatchObject({ ok: true });
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT content, rev FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "changedx", rev: 3 }]);
		});
	});

	it("rechecks ticket expiry, grant revocation, and epoch after candidate hashing", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-expiry.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const command = await appendCommand(path, "x", "append-expiry-key-001");
			const ticket = await authorizeAppend(fixture, command);
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let expired = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!expired && new TextDecoder().decode(data) === "basex") {
						expired = true;
						fixture.setNow(70_000);
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						command.intent,
						ticket,
						command,
						command.key,
					),
				).toEqual({ ok: false, failure: { kind: "invalid_ticket" } });
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT content, rev FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "base", rev: 1 }]);
		});
		await withTextStore(async (fixture) => {
			const path = "notes/append-revoked.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const command = await appendCommand(path, "x", "append-revoked-key-01");
			const ticket = await authorizeAppend(fixture, command);
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let revoked = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!revoked && new TextDecoder().decode(data) === "basex") {
						revoked = true;
						fixture.storage.sql.exec(
							"INSERT INTO revoked_grants(grant_id, at) VALUES (?, 10001)",
							TEXT_FIXTURE_CONTEXT.grant_id,
						);
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						command.intent,
						ticket,
						command,
						command.key,
					),
				).toEqual({ ok: false, failure: { kind: "revoked" } });
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT content, rev FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "base", rev: 1 }]);
		});
		await withTextStore(async (fixture) => {
			const path = "notes/append-epoch.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const command = await appendCommand(path, "x", "append-epoch-key-001");
			const ticket = await authorizeAppend(fixture, command);
			const nextEpoch = "f".repeat(32);
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let changed = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!changed && new TextDecoder().decode(data) === "basex") {
						changed = true;
						fixture.storage.sql.exec(
							"UPDATE meta SET value = ? WHERE key = 'epoch'",
							nextEpoch,
						);
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						command.intent,
						ticket,
						command,
						command.key,
					),
				).toEqual({
					ok: false,
					failure: { kind: "epoch_mismatch", current_epoch: nextEpoch },
				});
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT content, rev FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content: "base", rev: 1 }]);
		});
	});

	it("does not publish a candidate after an intervening native DELETE", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-delete-race.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const append = await appendCommand(path, "x", "append-delete-race-key");
			const appendTicket = await authorizeAppend(fixture, append);
			const deleteKey = IdempotencyKeySchema.parse("append-delete-race-delete");
			const deleteIntent = TextMutationIntentSchema.parse({
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
			const deleteLease = await fixture.coordinator.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				{
					op: "delete",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: deleteIntent.precondition,
				},
				deleteKey,
			);
			if (!deleteLease.ok) throw new Error("DELETE reservation failed");
			const deleteAdmission = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				deleteIntent,
				deleteLease.lease.admission_id,
			);
			if (!deleteAdmission.ok) throw new Error("DELETE authorization failed");
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let deleted = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!deleted && new TextDecoder().decode(data) === "basex") {
						deleted = true;
						expect(
							await fixture.store.commitText(
								TEXT_FIXTURE_CONTEXT,
								deleteIntent,
								deleteAdmission.ticket.id,
								undefined,
								deleteKey,
							),
						).toMatchObject({ ok: true });
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						append.intent,
						appendTicket,
						append,
						append.key,
					),
				).toEqual({ ok: false, failure: { kind: "tombstone" } });
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT rev, deleted, content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ rev: 2, deleted: 1, content: null }]);
		});
	});

	it("does not publish a candidate after an intervening native rename", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/append-rename-race.md";
			const destination = "notes/append-renamed.md";
			await seedLiveTextState(fixture.storage, { path, content: "base" });
			const append = await appendCommand(path, "x", "append-rename-race-key");
			const appendTicket = await authorizeAppend(fixture, append);
			const renameKey = IdempotencyKeySchema.parse("rename-race-append-key");
			const body = { to: destination };
			const bytes = JSON.stringify(body);
			const renameIntent = OperationIntentSchema.parse({
				op: "rename",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path, destination],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: await hashBytes(bytes),
				size: new TextEncoder().encode(bytes).byteLength,
			});
			const renameLease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path,
					if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
				renameKey,
			);
			if (!renameLease.ok) throw new Error("Rename reservation failed");
			const renameAdmission = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				renameIntent,
				renameLease.lease.admission_id,
				renameKey,
			);
			if (!renameAdmission.ok) throw new Error("Rename authorization failed");
			const renameCommand = FileCommandSchema.parse({
				op: "rename",
				intent: renameIntent,
				body,
				key: renameKey,
			});
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			let renamed = false;
			const spy = vi
				.spyOn(crypto.subtle, "digest")
				.mockImplementation(async (algorithm, data) => {
					if (!renamed && new TextDecoder().decode(data) === "basex") {
						renamed = true;
						expect(
							await fixture.store.commitFileCommand(
								TEXT_FIXTURE_CONTEXT,
								renameIntent,
								renameAdmission.ticket.id,
								renameCommand,
								renameKey,
							),
						).toMatchObject({ ok: true });
					}
					return digest(algorithm, data);
				});
			try {
				expect(
					await fixture.store.commitFileCommand(
						TEXT_FIXTURE_CONTEXT,
						append.intent,
						appendTicket,
						append,
						append.key,
					),
				).toEqual({ ok: false, failure: { kind: "tombstone" } });
			} finally {
				spy.mockRestore();
			}
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files WHERE path = ?", destination)
					.toArray(),
			).toEqual([{ path: destination, content: "base" }]);
		});
	});

	it.each(["notes/tombstone-append.md", "archive/deleted.bin"])(
		"returns a tombstone refusal for %s without changing retained state",
		async (path) => {
			await withTextStore(async (fixture) => {
				await seedLiveTextState(fixture.storage, { path, content: "deleted" });
				if (path.endsWith(".bin")) {
					fixture.storage.sql.exec(
						"UPDATE files SET kind = 'blob', content = NULL, blob_hash = hash WHERE path = ?",
						path,
					);
					fixture.storage.sql.exec(
						"UPDATE revisions SET kind = 'blob', content = NULL, blob_hash = hash WHERE path = ?",
						path,
					);
				}

				fixture.storage.sql.exec(
					"UPDATE files SET rev = 2, seq = 2, hash = '', size = 0, content = NULL, blob_hash = NULL, deleted = 1 WHERE path = ?",
					path,
				);
				fixture.storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 2, '', 0, ?, NULL, 1, 'seed-client', 322)",
					path,
					path.endsWith(".bin") ? "blob" : "text",
				);
				fixture.storage.sql.exec(
					"UPDATE meta SET value = '0' WHERE key = 'live_file_count'",
				);
				const command = await appendCommand(path, "x", "append-tombstone-key");
				const ticket = await authorizeAppend(fixture, command);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					command.intent,
					ticket,
					command,
					command.key,
				);
				expect(result).toEqual({ ok: false, failure: { kind: "tombstone" } });
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			});
		},
	);

	it.each([
		{ path: "archive/append-target.bin", size: 8 },
		{ path: "notes/large-append.md", size: 1_500_000 },
	])(
		"rejects blob reference $path without reading bytes or changing state",
		async ({ path, size }) => {
			await withTextStore(async (fixture) => {
				fixture.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,blob_hash,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, ?, 'blob', NULL, ?, 0, 321, 'seed-client')",
					path,
					path.toLowerCase(),
					"a".repeat(64),
					size,
					"a".repeat(64),
				);
				fixture.storage.sql.exec(
					"UPDATE meta SET value = '1' WHERE key = 'live_file_count'",
				);
				const command = await appendCommand(path, "x", "append-blob-key-001");
				const ticket = await authorizeAppend(fixture, command);
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					command.intent,
					ticket,
					command,
					command.key,
				);
				expect(result).toEqual({
					ok: false,
					failure: { kind: "unsupported_append_kind" },
				});
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			});
		},
	);

	it.each(["notes/missing-append.md", "archive/missing-append.bin"])(
		"returns not-found without publication for absent %s",
		async (path) => {
			await withTextStore(async (fixture) => {
				const content = "x";
				const key = IdempotencyKeySchema.parse("append-missing-key-1");
				const command = {
					op: "append" as const,
					intent: {
						op: "append" as const,
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: { kind: "none" as const },
						payload_hash: await hashBytes(content),
						size: 1,
					},
					content,
					key,
				};
				const reservation = await fixture.coordinator.beginMutation(
					TEXT_FIXTURE_CONTEXT,
					{
						op: "append",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: [path],
						precondition: { kind: "none" },
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
				const before = captureTextStoreState(fixture.storage);
				const result = await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					command.intent,
					admission.ticket.id,
					command,
				);
				expect(result).toEqual({ ok: false, failure: { kind: "not_found" } });
				expect(captureTextStoreState(fixture.storage)).toEqual(before);
			});
		},
	);
});
