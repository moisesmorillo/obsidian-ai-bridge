import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
	AdmissionFailure,
	AuthorizationContext,
	OperationIntent,
} from "@obsidian-ai-bridge/protocol";
import {
	formatETag,
	normalizePath,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import type { PreparedOperation } from "@worker/application/admission";
import {
	AdmissionDenied,
	prepareOperation,
} from "@worker/application/admission";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import {
	changes,
	files,
	meta,
	receipts,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import { captureVaultState } from "@worker/test-fixtures/admission";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

/** SHA-256 digest for an empty payload in canonical test intents. */
const EMPTY_PAYLOAD_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const firstReplacementEpoch = "fedcba9876543210fedcba9876543210";
const secondReplacementEpoch = "abcdef0123456789abcdef0123456789";
const initialTime = 1_000_000;

/** Mutable fake Unix clock in milliseconds for exact ticket deadline tests. */
type Clock = { value: number };
/** Raw stored admission columns, including expired rows that cleanup did not remove. */
type AdmissionTestRow = {
	id: string;
	client_id: string;
	grant_id: string;
	epoch: string;
	fingerprint: string;
	admitted_at: number;
	expires_at: number;
	state: "reserved" | "active" | "uncertain";
};
/** Test-only row data for path identity, revision, sequence, SHA-256, UTF-8 size, tombstone state, epoch, and time. */
type FileFixture = {
	path: string;
	pathKey: string;
	revision: number;
	sequence: number;
	hash: string;
	size: number;
	content: string | null;
	deleted: boolean;
	epoch: string;
	updatedAt: number;
};

/** Prepared test authorization with its active ticket identity and original Unix-millisecond deadline. */
type ActiveTicket = {
	context: AuthorizationContext;
	intent: OperationIntent;
	operation: PreparedOperation;
	ticketId: string;
	expiresAt: number;
};

/** Build deterministic authorization contexts for tests without token verification. */
function contextFor(
	clientId = "task3-client",
	grantId = "task3-grant",
	scopes: AuthorizationContext["scopes"] = ["vault:write"],
): AuthorizationContext {
	return { client_id: clientId, grant_id: grantId, scopes };
}

/** Read the stored epoch and return an empty sentinel when its metadata row is absent. */
function currentEpoch(storage: DurableObjectStorage): string {
	return (
		storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'epoch'")
			.toArray()[0]?.value ?? ""
	);
}

/** Read a named metadata value as a number, using zero when the row is absent. */
function currentMetaNumber(storage: DurableObjectStorage, key: string): number {
	return Number(
		storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
			.toArray()[0]?.value ?? "0",
	);
}

/** Build an authority with test-controlled milliseconds and deterministic ticket identifiers. */
function createAuthority(
	storage: DurableObjectStorage,
	clock: Clock = { value: initialTime },
	idBase = 0x1000,
): SqliteAdmissionAuthority {
	let nextId = idBase;
	return new SqliteAdmissionAuthority(storage, {
		now: () => clock.value,
		newTicketId: () => (nextId++).toString(16).padStart(32, "0"),
	});
}

/** Build a zero-byte put intent with a caller-selected precondition. Defaults use an absent-path condition and an empty payload. */
function putIntent(
	epoch: string,
	path: string,
	precondition: OperationIntent["precondition"] = { kind: "absent" },
	payloadHash = EMPTY_PAYLOAD_HASH,
): OperationIntent {
	return {
		op: "put",
		epoch,
		paths: [path],
		precondition,
		payload_hash: payloadHash,
		size: 0,
	};
}

/** Build a zero-byte read intent with no revision precondition. */
function readIntent(path: string): OperationIntent {
	return {
		op: "read",
		paths: [path],
		precondition: { kind: "none" },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	};
}

/** Prepare and authorize a test intent, then return its immutable operation and original deadline. */
async function openActiveTicket(
	_storage: DurableObjectStorage,
	authority: SqliteAdmissionAuthority,
	context: AuthorizationContext,
	intent: OperationIntent,
): Promise<ActiveTicket> {
	const operation = await prepareOperation(context, intent);
	const result = await authority.authorize(context, intent);
	if (!result.ok)
		throw new Error(`Ticket setup failed: ${result.failure.kind}`);
	return {
		context,
		intent,
		operation,
		ticketId: result.ticket.id,
		expiresAt: result.ticket.expires_at,
	};
}

/** Read all physical admission rows, including expired rows that await cleanup. */
function admissionRows(storage: DurableObjectStorage): AdmissionTestRow[] {
	return storage.sql
		.exec<AdmissionTestRow>("SELECT * FROM operation_admissions ORDER BY id")
		.toArray();
}

/** Capture application tables and FTS rows that commit tests may observe or change. */
function captureCompleteState(storage: DurableObjectStorage) {
	return {
		vault: captureVaultState(storage),
		admissions: admissionRows(storage),
		revisions: storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: storage.sql.exec("SELECT * FROM changes ORDER BY seq").toArray(),
		receipts: storage.sql
			.exec("SELECT * FROM receipts ORDER BY client_id, key")
			.toArray(),
		revokedGrants: storage.sql
			.exec("SELECT * FROM revoked_grants ORDER BY grant_id")
			.toArray(),
		clients: storage.sql.exec("SELECT * FROM clients ORDER BY id").toArray(),
		exportPins: storage.sql
			.exec("SELECT * FROM export_pins ORDER BY export_id, path, rev")
			.toArray(),
		blobRefs: storage.sql
			.exec("SELECT * FROM blob_refs ORDER BY hash")
			.toArray(),
		exports: storage.sql.exec("SELECT * FROM exports ORDER BY id").toArray(),
		filesFts: storage.sql
			.exec("SELECT rowid, path, content FROM files_fts ORDER BY rowid")
			.toArray(),
	};
}

/** Return a synchronous error for assertions, or undefined when the callback succeeds. */
function captureSynchronousError(run: () => void): unknown {
	try {
		run();
		return undefined;
	} catch (error) {
		return error;
	}
}

/** Run only admission consumption in the official Drizzle transaction used by the caller. */
function consumeInCallerTransaction(
	storage: DurableObjectStorage,
	authority: SqliteAdmissionAuthority,
	context: AuthorizationContext,
	operation: PreparedOperation,
	ticketId: string,
): void {
	const db = drizzle(storage, { schema: vaultSchema });
	db.transaction((tx) => {
		authority.consumeInTransaction(tx, context, operation, ticketId);
	});
}

/** Assert full state equality except removal of the selected admission row. */
function expectOnlyAdmissionConsumed(
	storage: DurableObjectStorage,
	before: ReturnType<typeof captureCompleteState>,
	ticketId: string,
): void {
	expect(captureCompleteState(storage)).toEqual({
		...before,
		admissions: before.admissions.filter((row) => row.id !== ticketId),
	});
}

/** Assert the denial class and exact structured failure returned by the guard. */
function expectAdmissionFailure(
	error: unknown,
	failure: AdmissionFailure,
): void {
	expect(error).toBeInstanceOf(AdmissionDenied);
	if (error instanceof AdmissionDenied) expect(error.failure).toEqual(failure);
}

/** Hash UTF-8 bytes with Web Crypto SHA-256 and return lowercase hexadecimal. */
async function hashText(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Seed valid file, history, feed, and metadata rows in native test storage.
 * Hashes and sizes use UTF-8 bytes.
 *
 * Live Markdown also updates FTS. Tombstones store null content and the empty hash.
 */
async function seedFile(
	storage: DurableObjectStorage,
	input: {
		path: string;
		revision?: number;
		content?: string;
		deleted?: boolean;
		now?: number;
	},
): Promise<FileFixture> {
	const path = normalizePath(input.path);
	const deleted = input.deleted ?? false;
	const content = deleted
		? null
		: (input.content ?? "observed fixture content");
	const hash = content === null ? EMPTY_PAYLOAD_HASH : await hashText(content);
	const size =
		content === null ? 0 : new TextEncoder().encode(content).byteLength;
	const revision = input.revision ?? 1;
	const now = input.now ?? initialTime;
	const epoch = currentEpoch(storage);
	const sequence = currentMetaNumber(storage, "head_seq") + 1;
	const liveFileCount = currentMetaNumber(storage, "live_file_count") + 1;
	const row: FileFixture = {
		path,
		pathKey: pathKey(path),
		revision,
		sequence,
		hash,
		size,
		content,
		deleted,
		epoch,
		updatedAt: now,
	};
	const db = drizzle(storage, { schema: vaultSchema });
	db.transaction((tx) => {
		tx.insert(files)
			.values({
				path: row.path,
				pathKey: row.pathKey,
				rev: row.revision,
				seq: row.sequence,
				hash: row.hash,
				size: row.size,
				kind: "text",
				content: row.content,
				blobHash: null,
				deleted: row.deleted ? 1 : 0,
				updatedAt: row.updatedAt,
				origin: "task3-fixture",
			})
			.run();
		tx.insert(revisions)
			.values({
				path: row.path,
				rev: row.revision,
				hash: row.hash,
				size: row.size,
				kind: "text",
				content: row.content,
				blobHash: null,
				deleted: row.deleted ? 1 : 0,
				origin: "task3-fixture",
				at: row.updatedAt,
			})
			.run();
		tx.insert(changes)
			.values({
				seq: row.sequence,
				op: row.deleted ? "delete" : "put",
				path: row.path,
				rev: row.revision,
				hash: row.hash,
				fromPath: null,
				fromRev: null,
				origin: "task3-fixture",
				at: row.updatedAt,
			})
			.run();
		if (!deleted && row.path.endsWith(".md"))
			tx.run(
				sql`INSERT INTO files_fts(path, content) VALUES (${row.path}, ${row.content})`,
			);
		tx.update(meta)
			.set({ value: String(row.sequence) })
			.where(eq(meta.key, "head_seq"))
			.run();
		if (!deleted)
			tx.update(meta)
				.set({ value: String(liveFileCount) })
				.where(eq(meta.key, "live_file_count"))
				.run();
	});
	return row;
}

/** Replace current file metadata and append matching history and feed rows for stale-revision tests. */
async function replaceFileRevision(
	storage: DurableObjectStorage,
	input: { path: string; revision: number; content: string; now: number },
): Promise<FileFixture> {
	const path = normalizePath(input.path);
	const hash = await hashText(input.content);
	const size = new TextEncoder().encode(input.content).byteLength;
	const epoch = currentEpoch(storage);
	const sequence = currentMetaNumber(storage, "head_seq") + 1;
	const row: FileFixture = {
		path,
		pathKey: pathKey(path),
		revision: input.revision,
		sequence,
		hash,
		size,
		content: input.content,
		deleted: false,
		epoch,
		updatedAt: input.now,
	};
	const db = drizzle(storage, { schema: vaultSchema });
	db.transaction((tx) => {
		tx.update(files)
			.set({
				rev: row.revision,
				seq: row.sequence,
				hash: row.hash,
				size: row.size,
				content: row.content,
				updatedAt: row.updatedAt,
			})
			.where(eq(files.path, row.path))
			.run();
		tx.insert(revisions)
			.values({
				path: row.path,
				rev: row.revision,
				hash: row.hash,
				size: row.size,
				kind: "text",
				content: row.content,
				blobHash: null,
				deleted: 0,
				origin: "task3-revision-fixture",
				at: row.updatedAt,
			})
			.run();
		tx.insert(changes)
			.values({
				seq: row.sequence,
				op: "put",
				path: row.path,
				rev: row.revision,
				hash: row.hash,
				fromPath: null,
				fromRev: null,
				origin: "task3-revision-fixture",
				at: row.updatedAt,
			})
			.run();
		tx.run(sql`DELETE FROM files_fts WHERE path = ${row.path}`);
		tx.run(
			sql`INSERT INTO files_fts(path, content) VALUES (${row.path}, ${row.content})`,
		);
		tx.update(meta)
			.set({ value: String(row.sequence) })
			.where(eq(meta.key, "head_seq"))
			.run();
	});
	return row;
}

/** Write generic test-only fixture rows after consumption in the same caller transaction. A forced error verifies rollback without modeling content algorithms. */
async function consumeAndWriteFixtureEffect(
	storage: DurableObjectStorage,
	authority: SqliteAdmissionAuthority,
	context: AuthorizationContext,
	operation: PreparedOperation,
	ticketId: string,
	options: { path?: string; throwAfterWrite?: boolean } = {},
): Promise<unknown> {
	const path = normalizePath(options.path ?? `task3-probe-${ticketId}.md`);
	const content = "task3 fixture content";
	const hash = await hashText(content);
	const size = new TextEncoder().encode(content).byteLength;
	const now = initialTime;
	const sequence = currentMetaNumber(storage, "head_seq") + 1;
	const liveFileCount = currentMetaNumber(storage, "live_file_count") + 1;
	const key = `task3-${ticketId}`;
	const db = drizzle(storage, { schema: vaultSchema });
	try {
		db.transaction((tx) => {
			authority.consumeInTransaction(tx, context, operation, ticketId);
			tx.insert(files)
				.values({
					path,
					pathKey: pathKey(path),
					rev: 1,
					seq: sequence,
					hash,
					size,
					kind: "text",
					content,
					blobHash: null,
					deleted: 0,
					updatedAt: now,
					origin: context.client_id,
				})
				.run();
			tx.insert(revisions)
				.values({
					path,
					rev: 1,
					hash,
					size,
					kind: "text",
					content,
					blobHash: null,
					deleted: 0,
					origin: context.client_id,
					at: now,
				})
				.run();
			tx.insert(changes)
				.values({
					seq: sequence,
					op: "put",
					path,
					rev: 1,
					hash,
					fromPath: null,
					fromRev: null,
					origin: context.client_id,
					at: now,
				})
				.run();
			tx.insert(receipts)
				.values({
					clientId: context.client_id,
					key,
					fingerprint: operation.fingerprint,
					status: 201,
					body: "{}",
					at: now,
				})
				.run();
			tx.run(
				sql`INSERT INTO files_fts(path, content) VALUES (${path}, ${content})`,
			);
			tx.update(meta)
				.set({ value: String(sequence) })
				.where(eq(meta.key, "head_seq"))
				.run();
			tx.update(meta)
				.set({ value: String(liveFileCount) })
				.where(eq(meta.key, "live_file_count"))
				.run();
			if (options.throwAfterWrite)
				throw new Error("forced fixture transaction rollback");
		});
		return undefined;
	} catch (error) {
		return error;
	}
}

/** Read revoked grant identities and first timestamps in grant order. Timestamps use Unix milliseconds. */
function revokedGrantRows(
	storage: DurableObjectStorage,
): { grant_id: string; at: number }[] {
	return storage.sql
		.exec<{ grant_id: string; at: number }>(
			"SELECT grant_id, at FROM revoked_grants ORDER BY grant_id",
		)
		.toArray();
}

describe("atomic admission consumption and revocation", () => {
	it("consumes one active ticket once and preserves an unrelated admission", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const clock = { value: initialTime };
			const authority = createAuthority(state.storage, clock);
			const epoch = currentEpoch(state.storage);
			const first = await openActiveTicket(
				state.storage,
				authority,
				contextFor("consume-owner", "consume-grant"),
				putIntent(epoch, "consume-once.md"),
			);
			const unrelated = await openActiveTicket(
				state.storage,
				authority,
				contextFor("unrelated-client", "unrelated-grant"),
				putIntent(epoch, "unrelated.md"),
			);

			const firstError = captureSynchronousError(() =>
				consumeInCallerTransaction(
					state.storage,
					authority,
					first.context,
					first.operation,
					first.ticketId,
				),
			);
			expect.soft(firstError).toBeUndefined();
			expect
				.soft(admissionRows(state.storage))
				.toEqual([expect.objectContaining({ id: unrelated.ticketId })]);

			const replayError = captureSynchronousError(() =>
				consumeInCallerTransaction(
					state.storage,
					authority,
					first.context,
					first.operation,
					first.ticketId,
				),
			);
			expectAdmissionFailure(replayError, { kind: "invalid_ticket" });
			expect(admissionRows(state.storage)).toEqual([
				expect.objectContaining({
					id: unrelated.ticketId,
					client_id: unrelated.context.client_id,
					grant_id: unrelated.context.grant_id,
				}),
			]);
		});
	});

	it.each(["client", "grant"] as const)(
		"rejects a foreign %s identity without consuming the owned row",
		async (identity) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				const authority = createAuthority(state.storage);
				const context = contextFor("identity-owner", "identity-grant");
				const active = await openActiveTicket(
					state.storage,
					authority,
					context,
					putIntent(currentEpoch(state.storage), "foreign-identity.md"),
				);
				const foreignContext =
					identity === "client"
						? { ...context, client_id: "different-client" }
						: { ...context, grant_id: "different-grant" };
				const before = captureCompleteState(state.storage);
				const error = await consumeAndWriteFixtureEffect(
					state.storage,
					authority,
					foreignContext,
					active.operation,
					active.ticketId,
				);
				if (identity === "client") {
					expectAdmissionFailure(error, { kind: "invalid_request" });
				} else {
					expectAdmissionFailure(error, { kind: "invalid_ticket" });
				}
				expect(captureCompleteState(state.storage)).toEqual(before);
			});
		},
	);

	it("rejects a foreign client with a consistently prepared operation as an unowned ticket", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const ownerContext = contextFor("provenance-owner", "provenance-grant");
			const active = await openActiveTicket(
				state.storage,
				authority,
				ownerContext,
				putIntent(currentEpoch(state.storage), "foreign-prepared.md"),
			);
			const foreignContext = {
				...ownerContext,
				client_id: "consistent-foreign-client",
			};
			const foreignOperation = await prepareOperation(
				foreignContext,
				active.intent,
			);
			const before = captureCompleteState(state.storage);
			const error = captureSynchronousError(() =>
				consumeInCallerTransaction(
					state.storage,
					authority,
					foreignContext,
					foreignOperation,
					active.ticketId,
				),
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rejects a changed prepared operation fingerprint and preserves its ticket", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("fingerprint-owner", "fingerprint-grant");
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "fingerprint-bound.md"),
			);
			const changedOperation = await prepareOperation(context, {
				...active.intent,
				payload_hash: "a".repeat(64),
			});
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				changedOperation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rejects a reserved lease as a content ticket", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("reserved-owner", "reserved-grant");
			const intent = putIntent(currentEpoch(state.storage), "reserved-only.md");
			const operation = await prepareOperation(context, intent);
			const lease = await authority.reserve(context, operation.descriptor);
			expect(lease.ok).toBe(true);
			if (!lease.ok) return;
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				operation,
				lease.lease.admission_id,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rejects read tickets for content consumption", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("read-owner", "read-grant", ["vault:read"]);
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				readIntent("read-ticket.md"),
			);
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it.each(["put", "delete", "rename", "append", "restore"] as const)(
		"consumes a valid %s operation through the common transaction guard",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				const authority = createAuthority(state.storage);
				const epoch = currentEpoch(state.storage);
				const path = `task3-common-${operationKind}.md`;
				const context = contextFor(
					`common-${operationKind}-client`,
					`common-${operationKind}-grant`,
					operationKind === "delete" ? ["vault:delete"] : ["vault:write"],
				);
				await seedFile(state.storage, {
					path,
					content: "common guard fixture",
					deleted: operationKind === "restore",
				});
				const match = {
					kind: "match" as const,
					etag: formatETag(epoch, 1),
				};
				let intent: OperationIntent;
				switch (operationKind) {
					case "put":
						intent = putIntent(epoch, path, match);
						break;
					case "delete":
						intent = {
							op: "delete",
							epoch,
							paths: [path],
							precondition: match,
							payload_hash: EMPTY_PAYLOAD_HASH,
							size: 0,
						};
						break;
					case "rename":
						intent = {
							op: "rename",
							epoch,
							paths: [path, path.toUpperCase()],
							precondition: match,
							payload_hash: "b".repeat(64),
							size: 0,
						};
						break;
					case "append":
						intent = {
							op: "append",
							epoch,
							paths: [path],
							precondition: { kind: "none" },
							payload_hash: EMPTY_PAYLOAD_HASH,
							size: 0,
						};
						break;
					case "restore":
						intent = {
							op: "restore",
							epoch,
							paths: [path],
							precondition: match,
							payload_hash: "a".repeat(64),
							size: 0,
						};
						break;
				}
				const active = await openActiveTicket(
					state.storage,
					authority,
					context,
					intent,
				);
				const before = captureCompleteState(state.storage);
				const error = captureSynchronousError(() =>
					consumeInCallerTransaction(
						state.storage,
						authority,
						context,
						active.operation,
						active.ticketId,
					),
				);
				expect(error).toBeUndefined();
				expectOnlyAdmissionConsumed(state.storage, before, active.ticketId);
			});
		},
	);

	it("consumes a valid ticket at the original deadline minus one millisecond", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const clock = { value: initialTime };
			const authority = createAuthority(state.storage, clock);
			const epoch = currentEpoch(state.storage);
			const ownerContext = contextFor("deadline-owner", "deadline-grant");
			const owner = await openActiveTicket(
				state.storage,
				authority,
				ownerContext,
				putIntent(epoch, "deadline-valid.md"),
			);
			const unrelated = await openActiveTicket(
				state.storage,
				authority,
				contextFor("deadline-other", "deadline-other-grant"),
				putIntent(epoch, "deadline-unrelated.md"),
			);
			clock.value = owner.expiresAt - 1;
			const before = captureCompleteState(state.storage);
			const error = captureSynchronousError(() =>
				consumeInCallerTransaction(
					state.storage,
					authority,
					owner.context,
					owner.operation,
					owner.ticketId,
				),
			);
			expect(error).toBeUndefined();
			expectOnlyAdmissionConsumed(state.storage, before, owner.ticketId);
			expect(admissionRows(state.storage)).toMatchObject([
				{ id: unrelated.ticketId, state: "active" },
			]);
		});
	});

	it("keeps an uncertain ticket charged and non-consumable", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("uncertain-owner", "uncertain-grant");
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "uncertain-ticket.md"),
			);
			expect(authority.finish(context, active.ticketId, "uncertain")).toEqual({
				ok: true,
			});
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
			expect(admissionRows(state.storage)).toMatchObject([
				{ id: active.ticketId, state: "uncertain" },
			]);
		});
	});

	it("rejects an expired ticket at its exact deadline without releasing it", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const clock = { value: initialTime };
			const authority = createAuthority(state.storage, clock);
			const context = contextFor("expired-owner", "expired-grant");
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "expired-ticket.md"),
			);
			clock.value = active.expiresAt;
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
			expect(admissionRows(state.storage)).toMatchObject([
				{ id: active.ticketId, state: "active", expires_at: active.expiresAt },
			]);
		});
	});

	it("persists revocation idempotently across eviction", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const grantId = "persistent-revocation-grant";
		const clock = { value: initialTime };
		let firstRows: { grant_id: string; at: number }[] = [];
		await runInDurableObject(stub, (_instance, state) => {
			const authority = createAuthority(state.storage, clock);
			const firstError = captureSynchronousError(() =>
				authority.recordRevocation(grantId),
			);
			expect.soft(firstError).toBeUndefined();
			firstRows = revokedGrantRows(state.storage);
			expect.soft(firstRows).toEqual([{ grant_id: grantId, at: clock.value }]);
			clock.value += 1_000;
			const secondError = captureSynchronousError(() =>
				authority.recordRevocation(grantId),
			);
			expect.soft(secondError).toBeUndefined();
			expect.soft(revokedGrantRows(state.storage)).toEqual(firstRows);
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, state) => {
			expect(revokedGrantRows(state.storage)).toEqual([
				{ grant_id: grantId, at: initialTime },
			]);
		});
	});

	it("rechecks revocation after admission before any fixture content effect", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("revoke-owner", "revoke-after-admission");
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "revoke-after-admission.md"),
			);
			const revocationError = captureSynchronousError(() =>
				authority.recordRevocation(context.grant_id),
			);
			expect.soft(revocationError).toBeUndefined();
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "revoked" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rechecks current scopes after admission before fixture SQL effects", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("scope-owner", "scope-change-grant");
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "scope-change.md"),
			);
			const changedContext: AuthorizationContext = {
				...context,
				scopes: ["vault:read"],
			};
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				changedContext,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "forbidden_scope" });
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rechecks the current epoch after admission before fixture SQL effects", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("epoch-owner", "epoch-change-grant");
			const oldEpoch = currentEpoch(state.storage);
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(oldEpoch, "epoch-change.md"),
			);
			const currentEpochAfterChange =
				oldEpoch === firstReplacementEpoch
					? secondReplacementEpoch
					: firstReplacementEpoch;
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'epoch'",
				currentEpochAfterChange,
			);
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, {
				kind: "epoch_mismatch",
				current_epoch: currentEpochAfterChange,
			});
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rechecks the current file revision and omits file content from failure metadata", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("revision-owner", "revision-change-grant");
			const epoch = currentEpoch(state.storage);
			const path = "Notes/Observed.md";
			await seedFile(state.storage, { path, content: "original private note" });
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, path, {
					kind: "match",
					etag: formatETag(epoch, 1),
				}),
			);
			const replacement = await replaceFileRevision(state.storage, {
				path,
				revision: 2,
				content: "replacement private note",
				now: initialTime + 1,
			});
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, {
				kind: "precondition_failed",
				etag: formatETag(epoch, 2),
				hash: replacement.hash,
				deleted: false,
			});
			if (error instanceof AdmissionDenied)
				expect(error.failure).not.toHaveProperty("content");
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rejects a live case-insensitive path_key collision from current metadata", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("collision-owner", "collision-grant");
			const epoch = currentEpoch(state.storage);
			const requestedPath = "notes/CONFLICT.md";
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, requestedPath),
			);
			const existing = await seedFile(state.storage, {
				path: "Notes/Conflict.md",
				content: "collision private content",
			});
			expect(pathKey(requestedPath)).toBe(existing.pathKey);
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, {
				kind: "precondition_failed",
				etag: formatETag(epoch, 1),
				hash: existing.hash,
				deleted: false,
			});
			if (error instanceof AdmissionDenied)
				expect(error.failure).not.toHaveProperty("content");
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("rejects an absent create when the exact requested path becomes live", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("exact-live-owner", "exact-live-grant");
			const epoch = currentEpoch(state.storage);
			const path = "exact-live-collision.md";
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, path),
			);
			const existing = await seedFile(state.storage, {
				path,
				content: "exact path current content",
			});
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, {
				kind: "precondition_failed",
				etag: formatETag(epoch, 1),
				hash: existing.hash,
				deleted: false,
			});
			if (error instanceof AdmissionDenied)
				expect(error.failure).not.toHaveProperty("content");
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("allows an absent create through an exact-path tombstone without changing file state", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor(
				"exact-tombstone-owner",
				"exact-tombstone-grant",
			);
			const epoch = currentEpoch(state.storage);
			const path = "exact-tombstone.md";
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, path),
			);
			const tombstone = await seedFile(state.storage, {
				path,
				deleted: true,
			});
			const before = captureCompleteState(state.storage);
			const error = captureSynchronousError(() =>
				consumeInCallerTransaction(
					state.storage,
					authority,
					context,
					active.operation,
					active.ticketId,
				),
			);
			expect(error).toBeUndefined();
			expectOnlyAdmissionConsumed(state.storage, before, active.ticketId);
			expect(
				state.storage.sql
					.exec<{ path: string; deleted: number; hash: string }>(
						"SELECT path, deleted, hash FROM files WHERE path = ?",
						path,
					)
					.toArray(),
			).toEqual([
				{
					path,
					deleted: 1,
					hash: tombstone.hash,
				},
			]);
		});
	});

	it("returns precondition_failed without metadata when the exact matched path is missing", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("missing-match-owner", "missing-match-grant");
			const epoch = currentEpoch(state.storage);
			const path = "missing-current-match.md";
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, path, {
					kind: "match",
					etag: formatETag(epoch, 1),
				}),
			);
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "precondition_failed" });
			if (error instanceof AdmissionDenied) {
				expect(error.failure).not.toHaveProperty("etag");
				expect(error.failure).not.toHaveProperty("hash");
				expect(error.failure).not.toHaveProperty("deleted");
				expect(error.failure).not.toHaveProperty("content");
			}
			expect(captureCompleteState(state.storage)).toEqual(before);
		});
	});

	it("allows an absent create through a matching tombstone path_key", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("tombstone-owner", "tombstone-grant");
			const epoch = currentEpoch(state.storage);
			const requestedPath = "notes/RESTORED.md";
			const tombstone = await seedFile(state.storage, {
				path: "Notes/Restored.md",
				deleted: true,
			});
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, requestedPath),
			);
			expect(pathKey(requestedPath)).toBe(tombstone.pathKey);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
				{ path: requestedPath },
			);
			expect(error).toBeUndefined();
			expect(admissionRows(state.storage)).toHaveLength(0);
			const rows = state.storage.sql
				.exec<{ path: string; path_key: string; deleted: number }>(
					"SELECT path, path_key, deleted FROM files WHERE path_key = ? ORDER BY path",
					pathKey(requestedPath),
				)
				.toArray();
			expect(rows).toHaveLength(2);
			expect(rows.filter((row) => row.deleted === 1)).toHaveLength(1);
			expect(rows.filter((row) => row.deleted === 0)).toHaveLength(1);
		});
	});

	it("rolls back consumption and fixture rows, then commits one retry effect", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("rollback-owner", "rollback-grant");
			const path = "atomic-retry.md";
			const active = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), path),
			);
			const before = captureCompleteState(state.storage);
			const rollbackError = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
				{ path, throwAfterWrite: true },
			);
			expect.soft(rollbackError).toMatchObject({
				message: "forced fixture transaction rollback",
			});
			expect.soft(captureCompleteState(state.storage)).toEqual(before);
			expect
				.soft(admissionRows(state.storage))
				.toEqual([
					expect.objectContaining({ id: active.ticketId, state: "active" }),
				]);

			const retryError = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
				{ path },
			);
			expect.soft(retryError).toBeUndefined();
			expect.soft(admissionRows(state.storage)).toHaveLength(0);
			expect
				.soft(
					state.storage.sql
						.exec("SELECT path FROM files WHERE path = ?", path)
						.toArray(),
				)
				.toHaveLength(1);
			expect
				.soft(
					state.storage.sql
						.exec("SELECT path FROM revisions WHERE path = ?", path)
						.toArray(),
				)
				.toHaveLength(1);
			expect
				.soft(
					state.storage.sql
						.exec("SELECT path FROM changes WHERE path = ?", path)
						.toArray(),
				)
				.toHaveLength(1);
			expect
				.soft(
					state.storage.sql
						.exec(
							"SELECT key FROM receipts WHERE client_id = ?",
							context.client_id,
						)
						.toArray(),
				)
				.toHaveLength(1);
			expect.soft(currentMetaNumber(state.storage, "head_seq")).toBe(1);
			expect.soft(currentMetaNumber(state.storage, "live_file_count")).toBe(1);
		});
	});

	it("keeps a later finish harmless after commit wins across two stubs", async () => {
		const id = env.VAULTS.newUniqueId();
		const firstStub = env.VAULTS.get(id);
		const secondStub = env.VAULTS.get(id);
		const context = contextFor(
			"two-stub-commit-client",
			"two-stub-commit-grant",
		);
		const clock = { value: initialTime };
		let pendingTicket: ActiveTicket | undefined;
		await runInDurableObject(firstStub, async (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x2000);
			pendingTicket = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "two-stub-commit.md"),
			);
		});
		const active = pendingTicket;
		if (!active) throw new Error("Ticket setup did not complete");

		await runInDurableObject(secondStub, async (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x3000);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
				{ path: "two-stub-commit.md" },
			);
			expect(error).toBeUndefined();
		});

		let replacementId = "";
		await runInDurableObject(firstStub, async (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x4000);
			expect(authority.finish(context, active.ticketId, "settled")).toEqual({
				ok: true,
			});
			const replacement = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "later-admission.md"),
			);
			replacementId = replacement.ticketId;
			expect(authority.finish(context, active.ticketId, "settled")).toEqual({
				ok: true,
			});
			expect(admissionRows(state.storage)).toEqual([
				expect.objectContaining({
					id: replacementId,
					client_id: context.client_id,
					grant_id: context.grant_id,
				}),
			]);
		});
	});

	it("keeps uncertain work charged when cancellation wins across two stubs", async () => {
		const id = env.VAULTS.newUniqueId();
		const firstStub = env.VAULTS.get(id);
		const secondStub = env.VAULTS.get(id);
		const context = contextFor(
			"two-stub-uncertain-client",
			"two-stub-uncertain-grant",
		);
		const clock = { value: initialTime };
		let pendingTicket: ActiveTicket | undefined;
		await runInDurableObject(firstStub, async (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x5000);
			pendingTicket = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(currentEpoch(state.storage), "two-stub-uncertain.md"),
			);
		});
		const active = pendingTicket;
		if (!active) throw new Error("Ticket setup did not complete");

		await runInDurableObject(secondStub, (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x6000);
			expect(authority.finish(context, active.ticketId, "uncertain")).toEqual({
				ok: true,
			});
		});
		await runInDurableObject(firstStub, async (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x7000);
			const before = captureCompleteState(state.storage);
			const error = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				active.operation,
				active.ticketId,
			);
			expectAdmissionFailure(error, { kind: "invalid_ticket" });
			expect(captureCompleteState(state.storage)).toEqual(before);
			expect(admissionRows(state.storage)).toMatchObject([
				{ id: active.ticketId, state: "uncertain" },
			]);
		});
		await runInDurableObject(secondStub, (_instance, state) => {
			const authority = createAuthority(state.storage, clock, 0x8000);
			expect(authority.finish(context, active.ticketId, "settled")).toEqual({
				ok: true,
			});
			expect(admissionRows(state.storage)).toHaveLength(0);
		});
	});

	it("recovers a lost authorization response when its original deadline expires", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const clock = { value: initialTime };
			const authority = createAuthority(state.storage, clock);
			const context = contextFor("lost-auth-client", "lost-auth-grant");
			const originalIntent = putIntent(
				currentEpoch(state.storage),
				"lost-authorization-response.md",
			);
			await authority.authorize(context, originalIntent);
			const originalRows = admissionRows(state.storage);
			expect(originalRows).toHaveLength(1);
			const oldId = originalRows[0]?.id;
			expect(oldId).toBeDefined();
			clock.value += 60_000;
			const replacementLease = await authority.reserve(context, originalIntent);
			expect(replacementLease.ok).toBe(true);
			if (!replacementLease.ok) return;
			expect(admissionRows(state.storage)).toEqual([
				expect.objectContaining({
					id: replacementLease.lease.admission_id,
					state: "reserved",
				}),
			]);
			expect(replacementLease.lease.admission_id).not.toBe(oldId);
		});
	});

	it("does not replay a lost commit or release another admission", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const authority = createAuthority(state.storage);
			const context = contextFor("lost-commit-client", "lost-commit-grant");
			const epoch = currentEpoch(state.storage);
			const committed = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, "lost-commit.md"),
			);
			const unrelated = await openActiveTicket(
				state.storage,
				authority,
				context,
				putIntent(epoch, "unrelated-commit.md"),
			);
			const commitError = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				committed.operation,
				committed.ticketId,
				{ path: "lost-commit.md" },
			);
			expect(commitError).toBeUndefined();
			const replayError = await consumeAndWriteFixtureEffect(
				state.storage,
				authority,
				context,
				committed.operation,
				committed.ticketId,
				{ path: "lost-commit.md" },
			);
			expectAdmissionFailure(replayError, { kind: "invalid_ticket" });
			expect(authority.finish(context, committed.ticketId, "settled")).toEqual({
				ok: true,
			});
			expect(admissionRows(state.storage)).toEqual([
				expect.objectContaining({ id: unrelated.ticketId }),
			]);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'lost-commit.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("keeps authorization-shaped bodies, headers, and guessed ticket paths default-deny", async () => {
		const ticketId = "0123456789abcdef0123456789abcdef";
		for (const path of [
			"/v1/tickets/consume",
			`/v1/tickets/${ticketId}/commit`,
			`/v1/admissions/${ticketId}/consume`,
		]) {
			const response = await SELF.fetch(`https://worker.invalid${path}`, {
				method: "POST",
				headers: {
					Authorization: "Bearer task3-test-token",
					"Content-Type": "application/json",
					"X-Operation-Ticket": ticketId,
				},
				body: JSON.stringify({
					client_id: "task3-test-client",
					grant_id: "task3-test-grant",
					scopes: ["vault:write"],
					ticket_id: ticketId,
				}),
			});
			expect(response.status).toBe(404);
		}
	});
});
