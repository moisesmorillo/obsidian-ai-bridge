import type {
	AuthorizationContext,
	FileCommand,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	PathSchema,
	pathKey,
	RenameReservationSchema,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	executeFileCommand,
	prepareHistoryCommand,
} from "@worker/application/history";
import { prepareTextPayload } from "@worker/application/text-payload";
import type { TextStoreFixture } from "@worker/test-fixtures/text-files";
import {
	captureTextStoreState,
	createEvictableTextVault,
	seedLiveTextState,
	TEXT_FIXTURE_CONTEXT,
	TEXT_FIXTURE_EPOCH,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Hash exact UTF-8 bytes for canonical history command body identity. */
async function hashBytes(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Build a strict restore command with its canonical request-byte digest. */
async function restoreCommand(
	path: string,
	sourceRevision: number,
	currentRevision: number,
	rawKey: string,
	asConflictCopy = false,
) {
	const body = { source_rev: sourceRevision, as_conflict_copy: asConflictCopy };
	const bytes = JSON.stringify(body);
	const intent = {
		op: "restore" as const,
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [path],
		precondition: {
			kind: "match" as const,
			etag: formatETag(TEXT_FIXTURE_EPOCH, currentRevision),
		},
		payload_hash: await hashBytes(bytes),
		size: new TextEncoder().encode(bytes).byteLength,
	};
	const command = FileCommandSchema.parse({
		op: "restore",
		intent,
		body,
		key: IdempotencyKeySchema.parse(rawKey),
	});
	if (command.op !== "restore")
		throw new Error("Restore command schema changed its operation");
	return command;
}

/** Reserve, authorize, and commit one command through real native admissions. */
async function commitCommand(
	fixture: TextStoreFixture,
	command: Extract<FileCommand, { op: "restore" }>,
	context: AuthorizationContext = TEXT_FIXTURE_CONTEXT,
) {
	const descriptor = {
		op: command.op,
		epoch: command.intent.epoch,
		paths: command.intent.paths,
		precondition: command.intent.precondition,
	};
	const reservation = await fixture.coordinator.beginMutation(
		context,
		descriptor,
		IdempotencyKeySchema.parse(command.key),
	);
	if (!reservation.ok)
		throw new Error(`Reservation failed: ${reservation.failure.kind}`);
	const admission = await fixture.admissions.authorize(
		context,
		command.intent,
		reservation.lease.admission_id,
	);
	if (!admission.ok)
		throw new Error(`Authorization failed: ${admission.failure.kind}`);
	return fixture.store.commitFileCommand(
		context,
		command.intent,
		admission.ticket.id,
		command,
		command.key,
	);
}

describe("native history mutations", () => {
	it("keeps exact renamed source bytes after real Durable Object eviction", async () => {
		const source = "notes/evicted-source.md";
		const destination = "notes/evicted-destination.md";
		const vault = await createEvictableTextVault(
			source,
			"exact-retained-content",
		);
		const { stub } = vault;
		const reservation = RenameReservationSchema.parse({
			path: source,
			if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
		});
		const lease = await stub.beginRenameSource(
			TEXT_FIXTURE_CONTEXT,
			reservation,
		);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const body = { to: destination };
		const payload = JSON.stringify(body);
		const intent = {
			op: "rename" as const,
			epoch: TEXT_FIXTURE_EPOCH,
			paths: [source, destination],
			precondition: { kind: "match" as const, etag: reservation.if_match },
			payload_hash: await hashBytes(payload),
			size: new TextEncoder().encode(payload).byteLength,
		};
		const authorized = await stub.authorizeRenameSource(
			TEXT_FIXTURE_CONTEXT,
			intent,
			lease.lease.admission_id,
		);
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const command = { op: "rename" as const, intent, body };
		expect(
			await stub.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				intent,
				authorized.ticket.id,
				command,
			),
		).toMatchObject({ ok: true });
		await vault.evict();
		const retained = await stub.readText(TEXT_FIXTURE_CONTEXT, {
			path: source,
			epoch: TEXT_FIXTURE_EPOCH,
			rev: 1,
		});
		expect(retained).toMatchObject({
			ok: true,
			body: { content: "exact-retained-content" },
		});
	});
	it("freezes the validated command snapshot before async commit work", async () => {
		const source = "notes/frozen-source.md";
		const destination = "notes/frozen-destination.md";
		const bytes = JSON.stringify({ to: destination });
		const intent = {
			op: "rename" as const,
			epoch: TEXT_FIXTURE_EPOCH,
			paths: [source, destination],
			precondition: {
				kind: "match" as const,
				etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
			},
			payload_hash: await hashBytes(bytes),
			size: new TextEncoder().encode(bytes).byteLength,
		};
		const command = FileCommandSchema.parse({
			op: "rename",
			intent,
			body: { to: destination },
		});
		const prepared = await prepareHistoryCommand(TEXT_FIXTURE_CONTEXT, command);
		if (prepared.command.op !== "rename" || command.op !== "rename")
			throw new Error("Rename command schema changed its operation");
		expect(Object.isFrozen(prepared.command)).toBe(true);
		expect(Object.isFrozen(prepared.command.intent.paths)).toBe(true);
		expect(Object.isFrozen(prepared.command.intent.precondition)).toBe(true);
		expect(Object.isFrozen(prepared.command.body)).toBe(true);
		Reflect.set(command.body, "to", source);
		expect(prepared.command.body.to).toBe(destination);
	});

	it("reads the rename body only after it reserves source capacity", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/barrier-source.md";
			const destination = "notes/barrier-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const reservation = RenameReservationSchema.parse({
				path: source,
				if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
			});
			const body = { to: destination };
			const payload = JSON.stringify(body);
			const command = {
				op: "rename" as const,
				intent: {
					op: "rename" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [source, destination],
					precondition: { kind: "match" as const, etag: reservation.if_match },
					payload_hash: await hashBytes(payload),
					size: new TextEncoder().encode(payload).byteLength,
				},
				body,
			};
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
			const result = await executeFileCommand(
				gateway,
				TEXT_FIXTURE_CONTEXT,
				reservation,
				undefined,
				async () => {
					expect(
						fixture.storage.sql
							.exec("SELECT state FROM operation_admissions ORDER BY state")
							.toArray(),
					).toEqual([{ state: "reserved" }, { state: "uncertain" }]);
					return command;
				},
			);
			expect(result).toMatchObject({
				ok: true,
				response: { body: { path: destination } },
			});
		});
	});
	it("activates a source-only rename lease only after the complete destination arrives", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/lease-source.md";
			const destination = "notes/body-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const reservation = RenameReservationSchema.parse({
				path: source,
				if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
			});
			const lease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				reservation,
			);
			expect(lease.ok).toBe(true);
			if (!lease.ok) return;
			const body = { to: destination };
			const payload = JSON.stringify(body);
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: { kind: "match" as const, etag: reservation.if_match },
				payload_hash: await hashBytes(payload),
				size: new TextEncoder().encode(payload).byteLength,
			};
			const authorized = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				lease.lease.admission_id,
			);
			expect(authorized).toMatchObject({ ok: true });
			if (!authorized.ok) return;
			expect(
				await fixture.admissions.authorizeRenameSource(
					TEXT_FIXTURE_CONTEXT,
					intent,
					lease.lease.admission_id,
				),
			).toEqual({ ok: false, failure: { kind: "invalid_ticket" } });
			const command = { op: "rename" as const, intent, body };
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					authorized.ticket.id,
					command,
				),
			).toMatchObject({ ok: true });
		});
	});
	it("restores exact retained bytes only with current destination consent", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/restore.md";
			await seedLiveTextState(fixture.storage, { path, content: "retained" });
			const updated = await fixture.store.commitText(
				TEXT_FIXTURE_CONTEXT,
				await putIntent(path, "current", formatETag(TEXT_FIXTURE_EPOCH, 1)),
				await authorizeTicket(fixture, path, "restore-update-key", 1),
				"current",
				IdempotencyKeySchema.parse("restore-update-key"),
			);
			expect(updated).toMatchObject({
				ok: true,
				response: { body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 2) } },
			});
			const body = { source_rev: 1, as_conflict_copy: true as const };
			const bytes = JSON.stringify(body);
			const command = {
				op: "restore" as const,
				intent: {
					op: "restore" as const,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: [path],
					precondition: {
						kind: "match" as const,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
					},
					payload_hash: await hashBytes(bytes),
					size: new TextEncoder().encode(bytes).byteLength,
				},
				body,
				key: "restore-command-key",
			};
			const result = await commitCommand(fixture, command);
			expect(result).toMatchObject({
				ok: true,
				response: {
					body: {
						etag: formatETag(TEXT_FIXTURE_EPOCH, 3),
						hash: await hashBytes("retained"),
					},
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
				{ rev: 1, content: "retained" },
				{ rev: 2, content: "current" },
				{ rev: 3, content: "retained" },
			]);
		});
	});

	it("does not resurrect a later delete on unkeyed retry and replays a keyed receipt", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/restore-retry.md";
			await seedLiveTextState(fixture.storage, { path, content: "retained" });
			const updateIntent = await putIntent(
				path,
				"displaced",
				formatETag(TEXT_FIXTURE_EPOCH, 1),
			);
			const updateTicket = await authorizeTicket(
				fixture,
				path,
				"restore-retry-update",
				1,
				"displaced",
			);
			const update = await fixture.store.commitText(
				TEXT_FIXTURE_CONTEXT,
				updateIntent,
				updateTicket,
				"displaced",
				IdempotencyKeySchema.parse("restore-retry-update"),
			);
			expect(update).toMatchObject({ ok: true });
			const restoreBody = { source_rev: 1, as_conflict_copy: true as const };
			const restoreBytes = JSON.stringify(restoreBody);
			const restoreIntent = {
				op: "restore" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
				},
				payload_hash: await hashBytes(restoreBytes),
				size: new TextEncoder().encode(restoreBytes).byteLength,
			};
			const restoreDescriptor = {
				op: "restore" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: restoreIntent.precondition,
			};
			const replayKey = IdempotencyKeySchema.parse(
				"restore-replay-after-delete",
			);
			const replayLease = await fixture.coordinator.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				restoreDescriptor,
				replayKey,
			);
			const staleLease = await fixture.coordinator.beginMutation(
				WRITE_ONLY_CONTEXT,
				restoreDescriptor,
			);
			if (!replayLease.ok || !staleLease.ok)
				throw new Error("Restore reservation failed");
			const replayAuth = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				restoreIntent,
				replayLease.lease.admission_id,
			);
			const staleAuth = await fixture.admissions.authorize(
				WRITE_ONLY_CONTEXT,
				restoreIntent,
				staleLease.lease.admission_id,
			);
			if (!replayAuth.ok || !staleAuth.ok)
				throw new Error("Restore authorization failed");
			const replayCommand = {
				op: "restore" as const,
				intent: restoreIntent,
				body: restoreBody,
				key: replayKey,
			};
			const first = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				restoreIntent,
				replayAuth.ticket.id,
				replayCommand,
				replayKey,
			);
			expect(first).toMatchObject({
				ok: true,
				response: { body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 3) } },
			});
			const deleteIntent = TextMutationIntentSchema.parse({
				op: "delete",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: {
					kind: "match",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 3),
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
				IdempotencyKeySchema.parse("restore-retry-delete"),
			);
			if (!deleteLease.ok) throw new Error("Delete reservation failed");
			const deleteAuth = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				deleteIntent,
				deleteLease.lease.admission_id,
			);
			if (!deleteAuth.ok) throw new Error("Delete authorization failed");
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					deleteIntent,
					deleteAuth.ticket.id,
					undefined,
					IdempotencyKeySchema.parse("restore-retry-delete"),
				),
			).toMatchObject({ ok: true });
			const afterDelete = captureTextStoreState(fixture.storage);
			const staleCommand = {
				op: "restore" as const,
				intent: restoreIntent,
				body: restoreBody,
			};
			const refused = await fixture.store.commitFileCommand(
				WRITE_ONLY_CONTEXT,
				restoreIntent,
				staleAuth.ticket.id,
				staleCommand,
			);
			expect(refused).toMatchObject({
				ok: false,
				failure: { kind: "precondition_failed" },
			});
			if (!refused.ok) expect(refused.failure).not.toHaveProperty("content");
			expect(captureTextStoreState(fixture.storage)).toEqual(afterDelete);
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					restoreIntent,
					replayAuth.ticket.id,
					replayCommand,
					replayKey,
				),
			).toEqual(first);
			expect(captureTextStoreState(fixture.storage)).toEqual(afterDelete);
		});
	});

	it("preserves restore claim ownership when a native caller omits or changes its key", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/restore-key-ownership.md";
			await seedLiveTextState(fixture.storage, { path, content: "retained" });
			const key = IdempotencyKeySchema.parse("restore-key-owner-01");
			const command = await restoreCommand(path, 1, 1, key, true);
			const descriptor = {
				op: "restore" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [path],
				precondition: command.intent.precondition,
			};
			const lease = await fixture.store.beginMutation(
				TEXT_FIXTURE_CONTEXT,
				descriptor,
				key,
			);
			if (!lease.ok) throw new Error("Restore reservation failed");
			const admission = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				lease.lease.admission_id,
			);
			if (!admission.ok) throw new Error("Restore authorization failed");
			const omittedKey = FileCommandSchema.parse({
				op: "restore",
				intent: command.intent,
				body: command.body,
			});
			const before = captureTextStoreState(fixture.storage);
			const omitted = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				omittedKey,
			);
			expect(omitted).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect(captureTextStoreState(fixture.storage)).toEqual(before);

			const wrongKey = IdempotencyKeySchema.parse("restore-wrong-key-01");
			const wrongCommand = FileCommandSchema.parse({
				op: "restore",
				intent: command.intent,
				body: command.body,
				key: wrongKey,
			});
			const wrong = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				wrongCommand,
				wrongKey,
			);
			expect(wrong).toEqual({ ok: false, failure: { kind: "invalid_ticket" } });
			expect(captureTextStoreState(fixture.storage)).toEqual(before);

			const committed = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				command.intent,
				admission.ticket.id,
				command,
				key,
			);
			expect(committed.ok).toBe(true);
			const afterCommit = captureTextStoreState(fixture.storage);
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					command.intent,
					admission.ticket.id,
					command,
					key,
				),
			).toEqual(committed);
			expect(captureTextStoreState(fixture.storage)).toEqual(afterCommit);
		});
	});

	it("preserves keyed rename claim ownership across direct commits", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/rename-key-ownership.md";
			const destination = "notes/rename-key-result.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const body = { to: destination };
			const payload = JSON.stringify(body);
			const key = IdempotencyKeySchema.parse("rename-key-owner-01");
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: await hashBytes(payload),
				size: new TextEncoder().encode(payload).byteLength,
			};
			const reservation = RenameReservationSchema.parse({
				path: source,
				if_match: intent.precondition.etag,
			});
			const lease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				reservation,
				key,
			);
			if (!lease.ok) throw new Error("Rename reservation failed");
			const admission = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				lease.lease.admission_id,
				key,
			);
			if (!admission.ok) throw new Error("Rename authorization failed");
			const command = FileCommandSchema.parse({
				op: "rename",
				intent,
				body,
				key,
			});
			const omittedKey = FileCommandSchema.parse({
				op: "rename",
				intent,
				body,
			});
			const before = captureTextStoreState(fixture.storage);
			const omitted = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				intent,
				admission.ticket.id,
				omittedKey,
			);
			expect(omitted).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect(captureTextStoreState(fixture.storage)).toEqual(before);

			const wrongKey = IdempotencyKeySchema.parse("rename-wrong-key-01");
			const wrongCommand = FileCommandSchema.parse({
				op: "rename",
				intent,
				body,
				key: wrongKey,
			});
			const wrong = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				intent,
				admission.ticket.id,
				wrongCommand,
				wrongKey,
			);
			expect(wrong).toEqual({ ok: false, failure: { kind: "invalid_ticket" } });
			expect(captureTextStoreState(fixture.storage)).toEqual(before);

			const committed = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				intent,
				admission.ticket.id,
				command,
				key,
			);
			expect(committed.ok).toBe(true);
			const afterCommit = captureTextStoreState(fixture.storage);
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
					key,
				),
			).toEqual(committed);
			expect(captureTextStoreState(fixture.storage)).toEqual(afterCommit);
		});
	});

	it("accepts an unkeyed rename source lease and native commit", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/rename-unkeyed-source.md";
			const destination = "notes/rename-unkeyed-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "unkeyed",
			});
			const body = { to: destination };
			const payload = JSON.stringify(body);
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: await hashBytes(payload),
				size: new TextEncoder().encode(payload).byteLength,
			};
			const reservation = RenameReservationSchema.parse({
				path: source,
				if_match: intent.precondition.etag,
			});
			const lease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				reservation,
			);
			if (!lease.ok) throw new Error("Unkeyed rename reservation failed");
			const admission = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				lease.lease.admission_id,
			);
			if (!admission.ok) throw new Error("Unkeyed rename authorization failed");
			const command = FileCommandSchema.parse({ op: "rename", intent, body });
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
				),
			).toMatchObject({ ok: true });
		});
	});

	it("rolls back rename at the safe-integer source revision boundary", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/max-revision.md";
			const destination = "notes/max-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
				revision: Number.MAX_SAFE_INTEGER,
			});
			const bytes = JSON.stringify({ to: destination });
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, Number.MAX_SAFE_INTEGER),
				},
				payload_hash: await hashBytes(bytes),
				size: new TextEncoder().encode(bytes).byteLength,
			};
			const key = IdempotencyKeySchema.parse("rename-max-rev-key-01");
			const lease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path: source,
					if_match: intent.precondition.etag,
				}),
				key,
			);
			if (!lease.ok) throw new Error("Rename reservation failed");
			const admission = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				lease.lease.admission_id,
				key,
			);
			if (!admission.ok) throw new Error("Rename authorization failed");
			const command = FileCommandSchema.parse({
				op: "rename",
				intent,
				body: { to: destination },
				key,
			});
			const before = captureTextStoreState(fixture.storage);
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
					key,
				),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	});

	it("restores exact renamed bytes after a later destination edit", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/exact-source.md";
			const destination = "notes/exact-destination.md";
			const original = "A\uFEFF\u0000é";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: original,
			});
			expect(await commitRename(fixture, source, destination, 1)).toMatchObject(
				{ ok: true },
			);
			const updateIntent = await putIntent(
				destination,
				"edited",
				formatETag(TEXT_FIXTURE_EPOCH, 1),
			);
			const updateTicket = await authorizeTicket(
				fixture,
				destination,
				"exact-destination-update",
				1,
				"edited",
			);
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					updateIntent,
					updateTicket,
					"edited",
					IdempotencyKeySchema.parse("exact-destination-update"),
				),
			).toMatchObject({ ok: true });
			const restore = await restoreCommand(
				destination,
				1,
				2,
				"exact-original-restore",
				true,
			);
			expect(await commitCommand(fixture, restore)).toMatchObject({
				ok: true,
				response: { body: { etag: formatETag(TEXT_FIXTURE_EPOCH, 3) } },
			});
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, content FROM revisions WHERE path = ? ORDER BY rev",
						destination,
					)
					.toArray(),
			).toEqual([
				{ rev: 1, content: original },
				{ rev: 2, content: "edited" },
				{ rev: 3, content: original },
			]);
		});
	});

	it("rejects absent, deleted, stale, and identical rename sources", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/source-preconditions.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const missing = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path: "notes/missing-source.md",
					if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
			);
			const stale = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path: source,
					if_match: formatETag(TEXT_FIXTURE_EPOCH, 2),
				}),
			);
			expect(missing).toEqual({
				ok: false,
				failure: { kind: "precondition_failed" },
			});
			expect(stale).toEqual({
				ok: false,
				failure: {
					kind: "precondition_failed",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
					hash: await hashBytes("source"),
					deleted: false,
					content: "source",
				},
			});
			let before: ReturnType<typeof captureTextStoreState> | undefined;
			const identical = await commitRename(
				fixture,
				source,
				source,
				1,
				(snapshot) => {
					before = snapshot;
				},
			);
			expect(identical).toEqual({
				ok: false,
				failure: { kind: "invalid_request" },
			});
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
			fixture.storage.sql.exec(
				"UPDATE files SET rev = 2, hash = '', size = 0, content = NULL, deleted = 1 WHERE path = ?",
				source,
			);
			const deleted = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path: source,
					if_match: formatETag(TEXT_FIXTURE_EPOCH, 1),
				}),
			);
			expect(deleted).toEqual({
				ok: false,
				failure: {
					kind: "precondition_failed",
					etag: formatETag(TEXT_FIXTURE_EPOCH, 2),
					hash: "",
					deleted: true,
				},
			});
		});
	});

	it("uses destination lifetime revision after ten retained tombstone revisions", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/restore-source.md";
			const destination = "notes/retired-target.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "moving",
			});
			const oldHash = "a".repeat(64);
			for (let rev = 1; rev <= 10; rev += 1) {
				const deleted = rev === 10;
				fixture.storage.sql.exec(
					"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, ?, ?, ?, 'text', ?, ?, 'retired-client', ?)",
					destination,
					rev,
					deleted ? "" : oldHash,
					deleted ? 0 : 3,
					deleted ? null : `old${rev}`,
					deleted ? 1 : 0,
					rev,
				);
			}
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 10, 1, '', 0, 'text', NULL, 1, 10, 'retired-client')",
				destination,
				pathKey(destination),
			);
			const result = await commitRename(fixture, source, destination, 1);
			expect(result).toMatchObject({
				ok: true,
				response: {
					body: {
						path: destination,
						etag: formatETag(TEXT_FIXTURE_EPOCH, 11),
						seq: 2,
					},
				},
			});
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, deleted, content FROM revisions WHERE path = ? ORDER BY rev",
						destination,
					)
					.toArray(),
			).toHaveLength(11);
			expect(
				fixture.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'live_file_count'")
					.toArray(),
			).toEqual([{ value: "1" }]);
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files_fts")
					.toArray(),
			).toEqual([{ path: destination, content: "moving" }]);
		});
	});

	it("rejects case-folded and NFC destination aliases without changing native state", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/source.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const existing = "notes/Café.md";
			const otherHash = await hashBytes("other");
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 2, ?, 5, 'text', 'other', 0, 322, 'seed-client')",
				existing,
				pathKey(existing),
				otherHash,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 5, 'text', 'other', 0, 'seed-client', 322)",
				existing,
				otherHash,
			);
			fixture.storage.sql.exec(
				"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (2, 'put', ?, 1, ?, 'seed-client', 322)",
				existing,
				otherHash,
			);
			fixture.storage.sql.exec(
				"INSERT INTO files_fts(path,content) VALUES (?, 'other')",
				existing,
			);
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '2' WHERE key IN ('head_seq', 'live_file_count')",
			);
			let before: ReturnType<typeof captureTextStoreState> | undefined;
			const refused = await commitRename(
				fixture,
				source,
				"notes/café.md",
				1,
				(snapshot) => {
					before = snapshot;
				},
			);
			expect(refused).toEqual({
				ok: false,
				failure: { kind: "path_collision", existing_path: existing },
			});
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
		});
	});

	it("replays a keyed rename after the source path becomes a tombstone", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/replay-source.md";
			const destination = "notes/replay-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const body = { to: destination };
			const bytes = JSON.stringify(body);
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: await hashBytes(bytes),
				size: new TextEncoder().encode(bytes).byteLength,
			};
			const reservation = RenameReservationSchema.parse({
				path: source,
				if_match: intent.precondition.etag,
			});
			const key = IdempotencyKeySchema.parse("rename-replay-dead-source");
			const command = FileCommandSchema.parse({
				op: "rename",
				intent,
				body,
				key,
			});
			const firstLease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				reservation,
				key,
			);
			if (!firstLease.ok) throw new Error("Initial rename reservation failed");
			const firstAuth = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				firstLease.lease.admission_id,
				key,
			);
			if (!firstAuth.ok) throw new Error("Initial rename authorization failed");
			const first = await fixture.store.commitFileCommand(
				TEXT_FIXTURE_CONTEXT,
				intent,
				firstAuth.ticket.id,
				command,
				key,
			);
			expect(first).toMatchObject({ ok: true });
			const replayLease = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				reservation,
				key,
			);
			expect(replayLease.ok).toBe(true);
			if (!replayLease.ok) throw new Error("Rename replay reservation failed");
			const replayAuth = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				replayLease.lease.admission_id,
				key,
			);
			if (!replayAuth.ok) throw new Error("Replay rename authorization failed");
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					replayAuth.ticket.id,
					command,
					key,
				),
			).toEqual(first);
			expect(
				fixture.storage.sql
					.exec("SELECT seq, op FROM changes ORDER BY seq")
					.toArray(),
			).toEqual([
				{ seq: 1, op: "put" },
				{ seq: 2, op: "rename" },
			]);
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
					.exec("SELECT COUNT(*) AS count FROM receipts WHERE key = ?", key)
					.toArray(),
			).toEqual([{ count: 1 }]);
		});
	});

	it("rolls back source and admission state when destination publication fails", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/rollback-source.md";
			const destination = "notes/rollback-destination.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "source",
			});
			const body = { to: destination };
			const bytes = JSON.stringify(body);
			const intent = {
				op: "rename" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [source, destination],
				precondition: {
					kind: "match" as const,
					etag: formatETag(TEXT_FIXTURE_EPOCH, 1),
				},
				payload_hash: await hashBytes(bytes),
				size: new TextEncoder().encode(bytes).byteLength,
			};
			const key = IdempotencyKeySchema.parse("rename-rollback-key-01");
			const reservation = await fixture.store.beginRenameSource(
				TEXT_FIXTURE_CONTEXT,
				RenameReservationSchema.parse({
					path: source,
					if_match: intent.precondition.etag,
				}),
				key,
			);
			if (!reservation.ok) throw new Error("Rename reservation failed");
			const admission = await fixture.admissions.authorizeRenameSource(
				TEXT_FIXTURE_CONTEXT,
				intent,
				reservation.lease.admission_id,
				key,
			);
			if (!admission.ok) throw new Error("Rename authorization failed");
			const command = FileCommandSchema.parse({
				op: "rename",
				intent,
				body,
				key,
			});
			fixture.storage.sql.exec(
				"CREATE TRIGGER fail_rename_destination BEFORE INSERT ON files WHEN NEW.path = 'notes/rollback-destination.md' BEGIN SELECT RAISE(ABORT, 'staged failure'); END",
			);
			const before = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
					key,
				),
			).rejects.toThrow();
			expect(captureTextStoreState(fixture.storage)).toEqual(before);
			fixture.storage.sql.exec("DROP TRIGGER fail_rename_destination");
			fixture.storage.sql.exec(
				"CREATE TRIGGER fail_rename_feed BEFORE UPDATE ON meta WHEN NEW.key = 'head_seq' BEGIN SELECT RAISE(ABORT, 'late staged failure'); END",
			);
			const beforeLateFailure = captureTextStoreState(fixture.storage);
			await expect(
				fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
					key,
				),
			).rejects.toThrow();
			expect(captureTextStoreState(fixture.storage)).toEqual(beforeLateFailure);
			fixture.storage.sql.exec("DROP TRIGGER fail_rename_feed");
			expect(
				await fixture.store.commitFileCommand(
					TEXT_FIXTURE_CONTEXT,
					intent,
					admission.ticket.id,
					command,
					key,
				),
			).toMatchObject({ ok: true });
		});
	});

	it("updates Markdown search paths across Markdown and Canvas renames", async () => {
		await withTextStore(async (fixture) => {
			const canvas = "notes/drawing.canvas";
			const markdown = "notes/drawing.md";
			await seedLiveTextState(fixture.storage, {
				path: canvas,
				content: "canvas body",
			});
			const toMarkdown = await commitRename(fixture, canvas, markdown, 1);
			expect(toMarkdown).toMatchObject({
				ok: true,
				response: { body: { seq: 2 } },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files_fts")
					.toArray(),
			).toEqual([{ path: markdown, content: "canvas body" }]);
			const toCanvas = await commitRename(fixture, markdown, canvas, 1);
			expect(toCanvas).toMatchObject({
				ok: true,
				response: { body: { seq: 3 } },
			});
			expect(
				fixture.storage.sql
					.exec("SELECT path, content FROM files_fts")
					.toArray(),
			).toEqual([]);
		});
	});

	it("permits a case-only rename and updates the current search path", async () => {
		await withTextStore(async (fixture) => {
			const source = "notes/Case.md";
			const destination = "notes/case.md";
			await seedLiveTextState(fixture.storage, {
				path: source,
				content: "case body",
			});
			const result = await commitRename(fixture, source, destination, 1);
			expect(result).toMatchObject({
				ok: true,
				response: { body: { path: destination, seq: 2 } },
			});
			expect(
				fixture.storage.sql.exec("SELECT path FROM files_fts").toArray(),
			).toEqual([{ path: destination }]);
		});
	});

	it("rejects pruned and deleted restore revisions and live occupied paths", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/restore-invalid.md";
			await seedLiveTextState(fixture.storage, { path, content: "current" });
			const beforeRows = fixture.storage.sql
				.exec(
					"SELECT rev, hash, content, deleted FROM revisions WHERE path = ? ORDER BY rev",
					path,
				)
				.toArray();
			expect(
				await commitCommand(
					fixture,
					await restoreCommand(path, 9, 1, "restore-pruned-key-001", true),
				),
			).toEqual({ ok: false, failure: { kind: "revision_pruned" } });
			expect(
				await commitCommand(
					fixture,
					await restoreCommand(path, 1, 1, "restore-occupied-key-01"),
				),
			).toEqual({ ok: false, failure: { kind: "path_occupied" } });
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, hash, content, deleted FROM revisions WHERE path = ? ORDER BY rev",
						path,
					)
					.toArray(),
			).toEqual(beforeRows);
		});
		await withTextStore(async (fixture) => {
			const path = "notes/deleted-restore-source.md";
			await seedLiveTextState(fixture.storage, { path, content: "live" });
			fixture.storage.sql.exec(
				"UPDATE files SET rev = 2, seq = 2, hash = '', size = 0, content = NULL, deleted = 1 WHERE path = ?",
				path,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 2, '', 0, 'text', NULL, 1, 'seed-client', 322)",
				path,
			);
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '0' WHERE key = 'live_file_count'",
			);
			const beforeRows = fixture.storage.sql
				.exec(
					"SELECT rev, hash, content, deleted FROM revisions WHERE path = ? ORDER BY rev",
					path,
				)
				.toArray();
			expect(
				await commitCommand(
					fixture,
					await restoreCommand(path, 2, 2, "restore-deleted-key-001", true),
				),
			).toEqual({ ok: false, failure: { kind: "invalid_request" } });
			expect(
				fixture.storage.sql
					.exec(
						"SELECT rev, hash, content, deleted FROM revisions WHERE path = ? ORDER BY rev",
						path,
					)
					.toArray(),
			).toEqual(beforeRows);
		});
	});

	it("rejects restore aliases for tombstoned path spellings", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/café.md";
			const alias = "notes/Café.md";
			await seedLiveTextState(fixture.storage, { path, content: "retained" });
			fixture.storage.sql.exec(
				"UPDATE files SET rev = 2, hash = '', size = 0, content = NULL, deleted = 1 WHERE path = ?",
				path,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 2, '', 0, 'text', NULL, 1, 'seed-client', 322)",
				path,
			);
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 2, ?, 5, 'text', 'other', 0, 322, 'seed-client')",
				alias,
				pathKey(alias),
				await hashBytes("other"),
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 5, 'text', 'other', 0, 'seed-client', 322)",
				alias,
				await hashBytes("other"),
			);
			const command = await restoreCommand(
				path,
				1,
				2,
				"restore-alias-key-001",
				true,
			);
			expect(await commitCommand(fixture, command)).toEqual({
				ok: false,
				failure: { kind: "path_collision", existing_path: alias },
			});
			expect(
				fixture.storage.sql
					.exec(
						"SELECT path, deleted FROM files WHERE path IN (?, ?) ORDER BY path",
						path,
						alias,
					)
					.toArray(),
			).toEqual([
				{ path: alias, deleted: 0 },
				{ path, deleted: 1 },
			]);
		});
	});

	it("moves and restores an immutable blob reference without text materialization", async () => {
		await withTextStore(async (fixture) => {
			const source = "archive/source-blob.md";
			const destination = "archive/moved-blob.md";
			const hash = "b".repeat(64);
			fixture.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,blob_hash,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, 8, 'blob', NULL, ?, 0, 321, 'seed-client')",
				source,
				pathKey(source),
				hash,
				hash,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,blob_hash,deleted,origin,at) VALUES (?, 1, ?, 8, 'blob', NULL, ?, 0, 'seed-client', 321)",
				source,
				hash,
				hash,
			);
			fixture.storage.sql.exec(
				"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (1, 'put', ?, 1, ?, 'seed-client', 321)",
				source,
				hash,
			);
			fixture.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key IN ('head_seq', 'live_file_count')",
			);
			expect(await commitRename(fixture, source, destination, 1)).toMatchObject(
				{ ok: true },
			);
			expect(
				fixture.storage.sql
					.exec(
						"SELECT kind, content, blob_hash FROM files WHERE path = ?",
						destination,
					)
					.toArray(),
			).toEqual([{ kind: "blob", content: null, blob_hash: hash }]);
			const restore = await restoreCommand(
				destination,
				1,
				1,
				"restore-blob-reference",
				true,
			);
			expect(await commitCommand(fixture, restore)).toMatchObject({ ok: true });
			expect(
				fixture.storage.sql
					.exec(
						"SELECT kind, content, blob_hash FROM files WHERE path = ?",
						destination,
					)
					.toArray(),
			).toEqual([{ kind: "blob", content: null, blob_hash: hash }]);
		});
	});

	it("returns ordered metadata for multiple retained revisions without content", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/ordered-history.md";
			const otherPath = "notes/unrelated-history.md";
			await seedLiveTextState(fixture.storage, { path, content: "first" });
			const updateIntent = await putIntent(
				path,
				"second",
				formatETag(TEXT_FIXTURE_EPOCH, 1),
			);
			const updateTicket = await authorizeTicket(
				fixture,
				path,
				"history-order-update",
				1,
				"second",
			);
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					updateIntent,
					updateTicket,
					"second",
					IdempotencyKeySchema.parse("history-order-update"),
				),
			).toMatchObject({ ok: true });
			const deleteIntent = TextMutationIntentSchema.parse({
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
			const deleteKey = IdempotencyKeySchema.parse("history-order-delete");
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
			if (!deleteLease.ok) throw new Error("History DELETE reservation failed");
			const deleteAdmission = await fixture.admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				deleteIntent,
				deleteLease.lease.admission_id,
			);
			if (!deleteAdmission.ok)
				throw new Error("History DELETE authorization failed");
			expect(
				await fixture.store.commitText(
					TEXT_FIXTURE_CONTEXT,
					deleteIntent,
					deleteAdmission.ticket.id,
					undefined,
					deleteKey,
				),
			).toMatchObject({ ok: true });
			fixture.storage.sql.exec(
				"DELETE FROM revisions WHERE path = ? AND rev = 2",
				path,
			);
			fixture.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 9, ?, 3, 'text', 'one', 0, 'other-client', 329), (?, 10, ?, 3, 'text', 'two', 0, 'other-client', 330)",
				otherPath,
				"a".repeat(64),
				otherPath,
				"b".repeat(64),
			);
			let reverseProbe: number[] = [];
			let pragmaError: string | undefined;
			let pragmaSet = false;
			try {
				fixture.storage.sql.exec("PRAGMA reverse_unordered_selects = ON");
				pragmaSet = true;
				reverseProbe = fixture.storage.sql
					.exec(
						"SELECT rev, hash, size, deleted, origin, at FROM revisions WHERE path = ?",
						path,
					)
					.toArray()
					.map(({ rev }) => Number(rev));
			} catch (error) {
				pragmaError = error instanceof Error ? error.message : String(error);
			}
			const reversedUnorderedScan =
				reverseProbe.length > 1 && reverseProbe[0] > reverseProbe[1];
			console.info(
				JSON.stringify({
					capability: "reverse_unordered_selects",
					available: reversedUnorderedScan,
					reverseProbe,
					pragmaError,
				}),
			);
			try {
				const history = await fixture.store.readHistory(TEXT_FIXTURE_CONTEXT, {
					path,
					epoch: TEXT_FIXTURE_EPOCH,
				});
				expect(history).toEqual({
					ok: true,
					entries: [
						{
							rev: 1,
							hash: await hashBytes("first"),
							size: 5,
							deleted: false,
							origin: "seed-client",
							at: 321,
						},
						{
							rev: 3,
							hash: "",
							size: 0,
							deleted: true,
							origin: TEXT_FIXTURE_CONTEXT.client_id,
							at: 10_000,
						},
					],
				});
				expect(JSON.stringify(history)).not.toContain("first");
				expect(JSON.stringify(history)).not.toContain("second");
			} finally {
				if (pragmaSet)
					fixture.storage.sql.exec("PRAGMA reverse_unordered_selects = OFF");
			}
		});
	});

	it("returns ordered history metadata without content fields", async () => {
		await withTextStore(async (fixture) => {
			const path = "notes/history.md";
			await seedLiveTextState(fixture.storage, {
				path,
				content: "secret-history-body",
			});
			const history = await fixture.store.readHistory(TEXT_FIXTURE_CONTEXT, {
				path,
				epoch: TEXT_FIXTURE_EPOCH,
			});
			expect(history).toEqual({
				ok: true,
				entries: [
					{
						rev: 1,
						hash: await hashBytes("secret-history-body"),
						size: 19,
						deleted: false,
						origin: "seed-client",
						at: 321,
					},
				],
			});
			expect(JSON.stringify(history)).not.toContain("secret-history-body");
		});
	});
});

/** Reserve, bind, and commit one rename, with an optional staged-state snapshot. */
async function commitRename(
	fixture: TextStoreFixture,
	source: string,
	requestedDestination: string,
	sourceRevision: number,
	captureBeforeCommit?: (
		snapshot: ReturnType<typeof captureTextStoreState>,
	) => void,
) {
	const destination = PathSchema.parse(requestedDestination);
	const body = { to: requestedDestination };
	const canonicalBody = JSON.stringify({ to: destination });
	const intent = {
		op: "rename" as const,
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [source, destination],
		precondition: {
			kind: "match" as const,
			etag: formatETag(TEXT_FIXTURE_EPOCH, sourceRevision),
		},
		payload_hash: await hashBytes(canonicalBody),
		size: new TextEncoder().encode(canonicalBody).byteLength,
	};
	const reservation = RenameReservationSchema.parse({
		path: source,
		if_match: intent.precondition.etag,
	});
	const lease = await fixture.store.beginRenameSource(
		TEXT_FIXTURE_CONTEXT,
		reservation,
	);
	if (!lease.ok)
		throw new Error(`Rename reservation failed: ${lease.failure.kind}`);
	const authorized = await fixture.admissions.authorizeRenameSource(
		TEXT_FIXTURE_CONTEXT,
		intent,
		lease.lease.admission_id,
	);
	if (!authorized.ok)
		throw new Error(`Rename authorization failed: ${authorized.failure.kind}`);
	const command = FileCommandSchema.parse({ op: "rename", intent, body });
	captureBeforeCommit?.(captureTextStoreState(fixture.storage));
	return fixture.store.commitFileCommand(
		TEXT_FIXTURE_CONTEXT,
		intent,
		authorized.ticket.id,
		command,
	);
}

/** Use write scope only to confirm that stale restore failures hide current content. */
const WRITE_ONLY_CONTEXT: AuthorizationContext = {
	client_id: TEXT_FIXTURE_CONTEXT.client_id,
	grant_id: TEXT_FIXTURE_CONTEXT.grant_id,
	scopes: ["vault:write"],
};

/** Build an exact UTF-8 text PUT intent used to create a displaced revision. */
async function putIntent(path: string, content: string, etag: string) {
	const payload = await prepareTextPayload(new TextEncoder().encode(content));
	return TextMutationIntentSchema.parse({
		op: "put",
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [path],
		precondition: { kind: "match", etag },
		payload_hash: payload.payload_hash,
		size: payload.size,
	});
}

/** Reserve and authorize a PUT before its native commit. */
async function authorizeTicket(
	fixture: TextStoreFixture,
	path: string,
	key: string,
	revision: number,
	content = "current",
) {
	const intent = await putIntent(
		path,
		content,
		formatETag(TEXT_FIXTURE_EPOCH, revision),
	);
	const reservation = await fixture.coordinator.beginMutation(
		TEXT_FIXTURE_CONTEXT,
		{
			op: "put",
			epoch: TEXT_FIXTURE_EPOCH,
			paths: [path],
			precondition: intent.precondition,
		},
		IdempotencyKeySchema.parse(key),
	);
	if (!reservation.ok)
		throw new Error(`Reservation failed: ${reservation.failure.kind}`);
	const admission = await fixture.admissions.authorize(
		TEXT_FIXTURE_CONTEXT,
		intent,
		reservation.lease.admission_id,
	);
	if (!admission.ok)
		throw new Error(`Authorization failed: ${admission.failure.kind}`);
	return admission.ticket.id;
}
