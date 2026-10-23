import type {
	AuthorizationContext,
	HistoryRequest,
	OperationIntent,
	TextMutationResult,
} from "@obsidian-ai-bridge/protocol";
import {
	classifyFilePath,
	EpochSchema,
	FileCommandSchema,
	formatETag,
	HistoryRequestSchema,
	HistoryResultSchema,
	OperationIntentSchema,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import {
	type ImmutableFileCommand,
	prepareHistoryCommand,
} from "@worker/application/history";
import {
	assertPolicyInTransaction,
	type VaultTransaction,
} from "@worker/infrastructure/sqlite/admission";
import {
	addLogicalPayload,
	changeLogicalPayloadBytes,
	revisionLogicalPayloadBytes,
} from "@worker/infrastructure/sqlite/capacity";
import type { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import {
	changes,
	files,
	meta,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Parsed native command with no mutable nested fields. */
type ReadonlyCommand = ImmutableFileCommand;
/** Append command whose input bytes bind its canonical fingerprint. */
type AppendCommand = Extract<ReadonlyCommand, { readonly op: "append" }>;
/** Rename command with a complete source and destination descriptor. */
type RenameCommand = Extract<ReadonlyCommand, { readonly op: "rename" }>;
/** Restore command with an exact retained revision and destination precondition. */
type RestoreCommand = Extract<ReadonlyCommand, { readonly op: "restore" }>;

/** Stores authorized history mutations in the same transaction as receipts and feed rows. */
export class SqliteHistoryStore {
	private readonly db;

	/** Bind the SQLite authority and the existing receipt and ticket coordinator. */
	constructor(
		storage: DurableObjectStorage,
		private readonly coordinator: SqliteMutationCoordinator,
		private readonly ports: { now: () => number; logger?: Logger },
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger: ports.logger });
	}

	/** Commit one validated command through the shared ticket and receipt transaction. */
	async commitFileCommand(
		context: AuthorizationContext,
		intent: OperationIntent,
		ticketId: string,
		command: ImmutableFileCommand,
		key?: string,
	): Promise<TextMutationResult> {
		const parsed = FileCommandSchema.safeParse(command);
		if (!parsed.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		try {
			const suppliedIntent = OperationIntentSchema.safeParse(intent);
			if (
				!suppliedIntent.success ||
				JSON.stringify(suppliedIntent.data) !==
					JSON.stringify(parsed.data.intent) ||
				(key !== undefined && parsed.data.key !== key)
			)
				return { ok: false, failure: { kind: "invalid_request" } };
			const prepared = await prepareHistoryCommand(context, parsed.data);
			const receiptKey = key ?? prepared.command.key;
			if (prepared.command.op === "append") {
				return this.commitAppend(
					context,
					ticketId,
					prepared.command,
					prepared.operation,
				);
			}
			const now = this.ports.now();
			if (!Number.isSafeInteger(now))
				return { ok: false, failure: { kind: "invalid_request" } };
			const command = prepared.command;
			if (command.op === "rename")
				return this.coordinator.commit(
					context,
					prepared.operation,
					ticketId,
					receiptKey,
					(tx) => publishRename(tx, context, command, now),
				);
			if (command.op === "restore")
				return this.coordinator.commit(
					context,
					prepared.operation,
					ticketId,
					receiptKey,
					(tx) => publishRestore(tx, context, command, now),
				);
			return { ok: false, failure: { kind: "invalid_request" } };
		} catch (error) {
			if (
				error instanceof AdmissionDenied ||
				error instanceof FileOperationDenied
			)
				return { ok: false, failure: error.failure };
			throw error;
		}
	}

	/** Read retained revision metadata only after native read-policy checks. */
	async readHistory(context: AuthorizationContext, request: HistoryRequest) {
		const parsed = HistoryRequestSchema.safeParse(request);
		if (!parsed.success)
			return {
				ok: false as const,
				failure: { kind: "invalid_request" as const },
			};
		const descriptor = {
			op: "read" as const,
			paths: [parsed.data.path],
			precondition: { kind: "none" as const },
			...(parsed.data.epoch === undefined ? {} : { epoch: parsed.data.epoch }),
		};
		try {
			return await this.db.transaction((tx) => {
				assertPolicyInTransaction(tx, context, {
					client_id: context.client_id,
					descriptor,
					descriptorFingerprint: "",
				});
				const cursor = tx
					.select({
						rev: revisions.rev,
						hash: revisions.hash,
						size: revisions.size,
						deleted: revisions.deleted,
						origin: revisions.origin,
						at: revisions.at,
					})
					.from(revisions)
					.where(eq(revisions.path, parsed.data.path))
					.orderBy(asc(revisions.rev))
					.all();
				return {
					ok: true as const,
					entries: HistoryResultSchema.parse(
						cursor.map((row) => ({ ...row, deleted: row.deleted === 1 })),
					),
				};
			});
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false as const, failure: error.failure };
			throw error;
		}
	}

	/** Prepare append bytes against current text and retry when an intervening commit changes it. */
	private async commitAppend(
		context: AuthorizationContext,
		ticketId: string,
		command: AppendCommand,
		operation: Awaited<ReturnType<typeof prepareHistoryCommand>>["operation"],
	): Promise<TextMutationResult> {
		const path = command.intent.paths[0];
		if (!path) return { ok: false, failure: { kind: "invalid_request" } };
		const replay = this.coordinator.replayIfPresent(
			context,
			operation,
			ticketId,
			command.key,
		);
		if (replay) return replay;
		for (;;) {
			let snapshot:
				| {
						rev: number;
						seq: number;
						hash: string;
						kind: string;
						deleted: number;
						content: string | null;
				  }
				| undefined;
			try {
				snapshot = this.db.transaction((tx) => {
					this.coordinator.assertActiveTicketInTransaction(
						tx,
						context,
						operation,
						ticketId,
						command.key,
					);
					const current = tx
						.select()
						.from(files)
						.where(eq(files.path, path))
						.all()[0];
					return current
						? {
								rev: current.rev,
								seq: current.seq,
								hash: current.hash,
								kind: current.kind,
								deleted: current.deleted,
								content: current.content,
							}
						: undefined;
				});
			} catch (error) {
				if (error instanceof AdmissionDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}
			if (!snapshot) return { ok: false, failure: { kind: "not_found" } };
			if (snapshot.deleted === 1)
				return { ok: false, failure: { kind: "tombstone" } };
			if (snapshot.kind !== "text" || snapshot.content === null)
				return { ok: false, failure: { kind: "unsupported_append_kind" } };
			const content = snapshot.content + command.content;
			const bytes = new TextEncoder().encode(content);
			if (bytes.byteLength > 1_000_000)
				return { ok: false, failure: { kind: "text_too_large" } };
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			const hash = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			try {
				return this.coordinator.commit(
					context,
					operation,
					ticketId,
					command.key,
					(tx) => {
						const current = tx
							.select()
							.from(files)
							.where(eq(files.path, path))
							.all()[0];
						if (
							!current ||
							current.rev !== snapshot.rev ||
							current.seq !== snapshot.seq ||
							current.hash !== snapshot.hash ||
							current.kind !== snapshot.kind ||
							current.deleted !== snapshot.deleted ||
							current.content !== snapshot.content
						)
							throw new RetryAppend();
						return publishTextCommand(
							tx,
							context,
							path,
							content,
							hash,
							bytes.byteLength,
							this.ports.now(),
						);
					},
				);
			} catch (error) {
				if (error instanceof RetryAppend) continue;
				if (
					error instanceof AdmissionDenied ||
					error instanceof FileOperationDenied
				)
					return { ok: false, failure: error.failure };
				throw error;
			}
		}
	}
}

/** Marks an append candidate whose observed current row changed before publication. */
class RetryAppend extends Error {}

/** Publish rename source tombstone and destination head in one feed transaction. */
function publishRename(
	tx: VaultTransaction,
	context: AuthorizationContext,
	command: RenameCommand,
	now: number,
) {
	const [sourcePath, destinationPath] = command.intent.paths;
	if (!sourcePath || !destinationPath || sourcePath === destinationPath)
		throw new FileOperationDenied({ kind: "invalid_request" });
	const source = tx
		.select()
		.from(files)
		.where(eq(files.path, sourcePath))
		.all()[0];
	if (!source) throw new FileOperationDenied({ kind: "not_found" });
	if (source.deleted === 1)
		throw new FileOperationDenied({ kind: "tombstone" });
	if (
		(source.kind === "text" && source.content === null) ||
		(source.kind === "blob" && source.blobHash === null) ||
		(source.kind !== "text" && source.kind !== "blob")
	)
		throw new FileOperationDenied({ kind: "invalid_request" });
	const destination = tx
		.select()
		.from(files)
		.where(eq(files.path, destinationPath))
		.all()[0];
	if (destination?.deleted === 0)
		throw new FileOperationDenied({
			kind: "path_collision",
			existing_path: destination.path ?? destinationPath,
		});
	const alias = tx
		.select()
		.from(files)
		.where(
			and(eq(files.pathKey, pathKey(destinationPath)), eq(files.deleted, 0)),
		)
		.all()
		.find((row) => row.path !== sourcePath);
	if (alias)
		throw new FileOperationDenied({
			kind: "path_collision",
			existing_path: alias.path ?? destinationPath,
		});
	const fromRev = source.rev + 1;
	const toRev = (destination?.rev ?? 0) + 1;
	const head = readCounter(tx, "head_seq");
	if (![fromRev, toRev, head + 1].every(Number.isSafeInteger))
		throw new FileOperationDenied({ kind: "invalid_request" });
	const seq = head + 1;
	const tombstone = {
		...source,
		rev: fromRev,
		seq,
		hash: "",
		size: 0,
		content: null,
		blobHash: null,
		renamedTo: destinationPath,
		deleted: 1,
		updatedAt: now,
		origin: context.client_id,
	};
	tx.update(files).set(tombstone).where(eq(files.path, sourcePath)).run();
	tx.insert(revisions)
		.values({
			path: sourcePath,
			rev: fromRev,
			hash: "",
			size: 0,
			kind: source.kind,
			content: null,
			blobHash: null,
			deleted: 1,
			origin: context.client_id,
			at: now,
		})
		.run();
	addLogicalPayload(
		tx,
		"revisions",
		revisionLogicalPayloadBytes({
			path: sourcePath,
			rev: fromRev,
			hash: "",
			size: 0,
			kind: source.kind,
			content: null,
			blobHash: null,
			deleted: 1,
			origin: context.client_id,
			at: now,
		}),
	);
	const change = tx
		.insert(changes)
		.values({
			op: "rename",
			path: destinationPath,
			rev: toRev,
			hash: source.hash,
			fromPath: sourcePath,
			fromRev,
			origin: context.client_id,
			at: now,
		})
		.returning({ seq: changes.seq })
		.all()[0];
	if (!change || change.seq !== seq) throw new Error("Rename sequence changed");
	addLogicalPayload(
		tx,
		"changes",
		changeLogicalPayloadBytes({
			seq: change.seq,
			op: "rename",
			path: destinationPath,
			rev: toRev,
			hash: source.hash,
			fromPath: sourcePath,
			fromRev,
			origin: context.client_id,
			at: now,
		}),
	);
	const moved = {
		...source,
		path: destinationPath,
		pathKey: pathKey(destinationPath),
		rev: toRev,
		seq,
		updatedAt: now,
		origin: context.client_id,
		renamedTo: null,
		deleted: 0,
	};
	if (destination)
		tx.update(files).set(moved).where(eq(files.path, destinationPath)).run();
	else tx.insert(files).values(moved).run();
	tx.insert(revisions)
		.values({
			path: destinationPath,
			rev: toRev,
			hash: source.hash,
			size: source.size,
			kind: source.kind,
			content: source.content,
			blobHash: source.blobHash,
			deleted: 0,
			origin: context.client_id,
			at: now,
		})
		.run();
	addLogicalPayload(
		tx,
		"revisions",
		revisionLogicalPayloadBytes({
			path: destinationPath,
			rev: toRev,
			hash: source.hash,
			size: source.size,
			kind: source.kind,
			content: source.content,
			blobHash: source.blobHash,
			deleted: 0,
			origin: context.client_id,
			at: now,
		}),
	);
	tx.run(
		sql`DELETE FROM files_fts WHERE path = ${sourcePath} OR path = ${destinationPath}`,
	);
	if (
		source.kind === "text" &&
		classifyFilePath(destinationPath) === "markdown"
	)
		tx.run(
			sql`INSERT INTO files_fts(path, content) VALUES (${destinationPath}, ${source.content ?? ""})`,
		);
	tx.update(meta)
		.set({ value: String(seq) })
		.where(eq(meta.key, "head_seq"))
		.run();
	const epoch = EpochSchema.parse(
		tx
			.select({ value: meta.value })
			.from(meta)
			.where(eq(meta.key, "epoch"))
			.all()[0]?.value,
	);
	return {
		status: 201 as const,
		body: {
			path: destinationPath,
			etag: formatETag(epoch, toRev),
			seq,
			hash: source.hash,
			size: source.size,
			deleted: false,
		},
	};
}

/** Publish a retained revision as a fresh ordinary PUT revision. */
function publishRestore(
	tx: VaultTransaction,
	context: AuthorizationContext,
	command: RestoreCommand,
	now: number,
) {
	const path = command.intent.paths[0];
	if (!path) throw new FileOperationDenied({ kind: "invalid_request" });
	const source = tx
		.select()
		.from(revisions)
		.where(
			and(eq(revisions.path, path), eq(revisions.rev, command.body.source_rev)),
		)
		.all()[0];
	if (!source) throw new FileOperationDenied({ kind: "revision_pruned" });
	if (
		source.deleted === 1 ||
		(source.kind === "text" && source.content === null) ||
		(source.kind === "blob" && source.blobHash === null) ||
		(source.kind !== "text" && source.kind !== "blob")
	)
		throw new FileOperationDenied({ kind: "invalid_request" });
	const current = tx.select().from(files).where(eq(files.path, path)).all()[0];
	if (current?.deleted === 0 && command.body.as_conflict_copy !== true)
		throw new FileOperationDenied({ kind: "path_occupied" });
	const alias = tx
		.select()
		.from(files)
		.where(and(eq(files.pathKey, pathKey(path)), eq(files.deleted, 0)))
		.all()
		.find((row) => row.path !== path);
	if (alias)
		throw new FileOperationDenied({
			kind: "path_collision",
			existing_path: alias.path ?? path,
		});
	return publishTextCommand(
		tx,
		context,
		path,
		source.content ?? "",
		source.hash,
		source.size,
		now,
		source.kind,
		source.blobHash,
	);
}

/** Publish text content and its ordinary PUT receipt row. */
function publishTextCommand(
	tx: VaultTransaction,
	context: AuthorizationContext,
	path: string,
	content: string,
	hash: string,
	size: number,
	now: number,
	kind = "text",
	blobHash: string | null = null,
) {
	if (!Number.isSafeInteger(now))
		throw new FileOperationDenied({ kind: "invalid_request" });
	const prior = tx.select().from(files).where(eq(files.path, path)).all()[0];
	const rev = (prior?.rev ?? 0) + 1;
	const seq = readCounter(tx, "head_seq") + 1;
	if (![rev, seq].every(Number.isSafeInteger))
		throw new FileOperationDenied({ kind: "invalid_request" });
	const change = tx
		.insert(changes)
		.values({ op: "put", path, rev, hash, origin: context.client_id, at: now })
		.returning({ seq: changes.seq })
		.all()[0];
	if (!change || change.seq !== seq)
		throw new Error("Mutation sequence changed");
	addLogicalPayload(
		tx,
		"changes",
		changeLogicalPayloadBytes({
			seq: change.seq,
			op: "put",
			path,
			rev,
			hash,
			origin: context.client_id,
			at: now,
		}),
	);
	const values = {
		path,
		pathKey: pathKey(path),
		rev,
		seq,
		hash,
		size,
		kind,
		content: kind === "text" ? content : null,
		blobHash,
		renamedTo: null,
		deleted: 0,
		updatedAt: now,
		origin: context.client_id,
	};
	if (prior) tx.update(files).set(values).where(eq(files.path, path)).run();
	else tx.insert(files).values(values).run();
	tx.insert(revisions)
		.values({
			path,
			rev,
			hash,
			size,
			kind,
			content: kind === "text" ? content : null,
			blobHash,
			deleted: 0,
			origin: context.client_id,
			at: now,
		})
		.run();
	addLogicalPayload(
		tx,
		"revisions",
		revisionLogicalPayloadBytes({
			path,
			rev,
			hash,
			size,
			kind,
			content: kind === "text" ? content : null,
			blobHash,
			deleted: 0,
			origin: context.client_id,
			at: now,
		}),
	);
	tx.run(sql`DELETE FROM files_fts WHERE path = ${path}`);
	if (kind === "text" && classifyFilePath(path) === "markdown")
		tx.run(
			sql`INSERT INTO files_fts(path, content) VALUES (${path}, ${content})`,
		);
	tx.update(meta)
		.set({ value: String(seq) })
		.where(eq(meta.key, "head_seq"))
		.run();
	if (!prior || prior.deleted === 1) {
		const liveCount = readCounter(tx, "live_file_count");
		if (!Number.isSafeInteger(liveCount + 1))
			throw new FileOperationDenied({ kind: "invalid_request" });
		tx.update(meta)
			.set({ value: String(liveCount + 1) })
			.where(eq(meta.key, "live_file_count"))
			.run();
	}
	const epoch = EpochSchema.parse(
		tx
			.select({ value: meta.value })
			.from(meta)
			.where(eq(meta.key, "epoch"))
			.all()[0]?.value,
	);
	return {
		status: prior?.deleted === 0 ? (200 as const) : (201 as const),
		body: {
			path,
			etag: formatETag(epoch, rev),
			seq,
			hash,
			size,
			deleted: false,
		},
	};
}

/** Read one canonical counter from the active transaction. */
function readCounter(tx: VaultTransaction, key: string): number {
	const value = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, key))
		.all()[0]?.value;
	if (
		value === undefined ||
		!/^(0|[1-9][0-9]*)$/.test(value) ||
		!Number.isSafeInteger(Number(value))
	)
		throw new Error("Invalid vault counter");
	return Number(value);
}
