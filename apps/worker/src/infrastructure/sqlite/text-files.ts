import type {
	AuthorizationContext,
	HistoryRequest,
	IdempotencyKey,
	MutationReceipt,
	OperationDescriptor,
	OperationIntent,
	RenameReservation,
	TextMutationBeginResult,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
	TextReadResponse,
	TextReadResult,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	EpochSchema,
	formatETag,
	OperationDescriptorSchema,
	pathKey,
	TextMutationDescriptorSchema,
	TextMutationIntentSchema,
	TextReadRequestSchema,
	TextReadResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	AdmissionDenied,
	type PreparedOperation,
	prepareOperation,
} from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import type { ImmutableFileCommand } from "@worker/application/history";
import { prepareTextPayload } from "@worker/application/text-payload";
import {
	assertPolicyInTransaction,
	type VaultTransaction,
} from "@worker/infrastructure/sqlite/admission";
import { SqliteHistoryStore } from "@worker/infrastructure/sqlite/history";
import type { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import {
	changes,
	files,
	meta,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Stores and reads exact inline text through native SQLite transactions. */
export class SqliteTextStore {
	private readonly db;
	private readonly history: SqliteHistoryStore;

	/** Bind the native store, atomic coordinator, and Unix-millisecond clock. */
	constructor(
		storage: DurableObjectStorage,
		private readonly coordinator: SqliteMutationCoordinator,
		private readonly ports: { now: () => number; logger?: Logger },
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger: ports.logger });
		this.history = new SqliteHistoryStore(storage, coordinator, ports);
	}

	/** Reserve a ticket and optional idempotency claim for a text mutation. */
	async beginMutation(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult> {
		const parsed = OperationDescriptorSchema.safeParse(descriptor);
		if (!parsed.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		const path = parsed.data.paths[0];
		if (path === undefined)
			return { ok: false, failure: { kind: "invalid_request" } };
		if (parsed.data.op === "append") {
			if (parsed.data.epoch === undefined)
				return { ok: false, failure: { kind: "invalid_request" } };
			if (key === undefined)
				return { ok: false, failure: { kind: "idempotency_key_required" } };
			if (!path.endsWith(".md") && !path.endsWith(".canvas"))
				return { ok: false, failure: { kind: "not_implemented" } };
			return this.coordinator.beginMutation(context, parsed.data, key);
		}
		if (parsed.data.op === "restore")
			return this.coordinator.beginMutation(context, parsed.data, key);
		const textDescriptor = TextMutationDescriptorSchema.safeParse(parsed.data);
		if (!textDescriptor.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		if (!path.endsWith(".md") && !path.endsWith(".canvas"))
			return { ok: false, failure: { kind: "not_implemented" } };
		return this.coordinator.beginMutation(context, textDescriptor.data, key);
	}

	/** Recompute payload identity, consume the ticket, and publish text plus receipt atomically. */
	async commitText(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		ticketId: string,
		content: string | undefined,
		key?: IdempotencyKey,
	): Promise<TextMutationResult> {
		const parsed = TextMutationIntentSchema.safeParse(intent);
		if (!parsed.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		const operationIntent = parsed.data;
		if (
			!operationIntent.paths[0]?.endsWith(".md") &&
			!operationIntent.paths[0]?.endsWith(".canvas")
		)
			return { ok: false, failure: { kind: "not_implemented" } };
		if (operationIntent.op === "delete") {
			if (
				content !== undefined ||
				operationIntent.payload_hash !== EMPTY_PAYLOAD_HASH ||
				operationIntent.size !== 0
			)
				return { ok: false, failure: { kind: "invalid_request" } };
		} else {
			if (content === undefined)
				return { ok: false, failure: { kind: "invalid_request" } };
			try {
				const payload = await prepareTextPayload(
					new TextEncoder().encode(content),
				);
				if (
					payload.content !== content ||
					payload.payload_hash !== operationIntent.payload_hash ||
					payload.size !== operationIntent.size
				)
					return { ok: false, failure: { kind: "invalid_request" } };
			} catch (error) {
				if (error instanceof FileOperationDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}
		}
		let operation: PreparedOperation;
		try {
			operation = await prepareOperation(context, operationIntent);
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
		const now = this.ports.now();
		if (!Number.isSafeInteger(now))
			return { ok: false, failure: { kind: "invalid_request" } };
		try {
			return this.coordinator.commit(context, operation, ticketId, key, (tx) =>
				publishText(tx, context, operationIntent, content, now),
			);
		} catch (error) {
			if (error instanceof FileOperationDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
	}

	/** Reserve rename source capacity before the body reveals its destination. */
	beginRenameSource(
		context: AuthorizationContext,
		reservation: RenameReservation,
		key?: IdempotencyKey,
	) {
		return this.coordinator.beginRenameSource(context, reservation, key);
	}

	/** Commit one native history command through the shared admission coordinator. */
	commitFileCommand(
		context: AuthorizationContext,
		intent: OperationIntent,
		ticketId: string,
		command: ImmutableFileCommand,
		key?: IdempotencyKey,
	): Promise<TextMutationResult> {
		return this.history.commitFileCommand(
			context,
			intent,
			ticketId,
			command,
			key,
		);
	}

	/** Read retained content-free history metadata after native policy checks. */
	readHistory(context: AuthorizationContext, request: HistoryRequest) {
		return this.history.readHistory(context, request);
	}

	/** Read one current or selected historical text row from a policy-checked snapshot. */
	async readText(
		context: AuthorizationContext,
		request: TextReadRequest,
	): Promise<TextReadResult> {
		const parsed = TextReadRequestSchema.safeParse(request);
		if (!parsed.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		const value = parsed.data;
		const descriptor: OperationDescriptor = {
			op: "read",
			paths: [value.path],
			precondition: { kind: "none" },
			...(value.epoch === undefined ? {} : { epoch: value.epoch }),
		};
		try {
			const result = await this.db.transaction((tx) => {
				const epoch = assertPolicyInTransaction(tx, context, {
					client_id: context.client_id,
					descriptor,
					descriptorFingerprint: "",
				});
				const revision = value.rev;
				const row =
					revision === undefined
						? tx
								.select({
									path: files.path,
									rev: files.rev,
									hash: files.hash,
									size: files.size,
									kind: files.kind,
									content: files.content,
									deleted: files.deleted,
									origin: files.origin,
									at: files.updatedAt,
								})
								.from(files)
								.where(eq(files.path, value.path))
								.all()[0]
						: tx
								.select({
									path: revisions.path,
									rev: revisions.rev,
									hash: revisions.hash,
									size: revisions.size,
									kind: revisions.kind,
									content: revisions.content,
									deleted: revisions.deleted,
									origin: revisions.origin,
									at: revisions.at,
								})
								.from(revisions)
								.where(
									and(
										eq(revisions.path, value.path),
										eq(revisions.rev, revision),
									),
								)
								.all()[0];
				if (!row)
					return {
						ok: false as const,
						failure: {
							kind:
								revision === undefined
									? ("not_found" as const)
									: ("revision_pruned" as const),
						},
					};
				if (row.kind !== "text")
					return {
						ok: false as const,
						failure: { kind: "not_implemented" as const },
					};
				const deleted = row.deleted === 1;
				const fullText = deleted ? "" : row.content;
				if (fullText === null)
					return {
						ok: false as const,
						failure: { kind: "not_implemented" as const },
					};
				const offset = value.offset ?? 0;
				const selected = fullText.slice(
					offset,
					offset + (value.length ?? fullText.length),
				);
				const body: TextReadResponse = TextReadResponseSchema.parse({
					path: row.path,
					etag: formatETag(epoch, row.rev),
					hash: deleted ? "" : row.hash,
					size: deleted ? 0 : row.size,
					kind: "text",
					deleted,
					origin: row.origin,
					updated_at: row.at,
					content: deleted ? null : selected,
					offset,
					length: deleted ? 0 : selected.length,
					truncated:
						!deleted && (offset !== 0 || selected.length !== fullText.length),
				});
				return { ok: true as const, body };
			});
			return result;
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
	}
}

/** Write one revision, feed row, file head, counters, and Markdown search row in the coordinator transaction. */
function publishText(
	tx: VaultTransaction,
	context: AuthorizationContext,
	intent: TextMutationIntent,
	content: string | undefined,
	now: number,
): MutationReceipt {
	const path = intent.paths[0];
	if (path === undefined) throw new Error("Text mutation has no path");
	const prior = tx.select().from(files).where(eq(files.path, path)).all()[0];
	if (prior?.kind === "blob")
		throw new FileOperationDenied({ kind: "not_implemented" });
	const priorRevision = prior?.rev ?? 0;
	const revision = priorRevision + 1;
	const headText = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, "head_seq"))
		.all()[0]?.value;
	const liveText = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, "live_file_count"))
		.all()[0]?.value;
	const head = parseCounter(headText);
	const live = parseCounter(liveText);
	if (
		!Number.isSafeInteger(revision) ||
		revision <= 0 ||
		!Number.isSafeInteger(head + 1)
	)
		throw new Error("Unsafe text revision or sequence");
	const deleted = intent.op === "delete";
	const hash = deleted ? "" : intent.payload_hash;
	const size = deleted ? 0 : intent.size;
	const nextLive =
		live +
		(deleted
			? prior?.deleted === 0
				? -1
				: 0
			: prior && prior.deleted === 0
				? 0
				: 1);
	if (!Number.isSafeInteger(nextLive) || nextLive < 0)
		throw new Error("Unsafe live file counter");
	const at = now;
	const change = tx
		.insert(changes)
		.values({
			op: deleted ? "delete" : "put",
			path,
			rev: revision,
			hash,
			origin: context.client_id,
			at,
		})
		.returning({ seq: changes.seq })
		.all()[0];
	if (!change || !Number.isSafeInteger(change.seq) || change.seq <= head)
		throw new Error("Unsafe text change sequence");
	const values = {
		path,
		pathKey: pathKey(path),
		rev: revision,
		seq: change.seq,
		hash,
		size,
		kind: "text",
		content: deleted ? null : (content ?? null),
		blobHash: null,
		deleted: deleted ? 1 : 0,
		updatedAt: at,
		origin: context.client_id,
	};
	if (prior) tx.update(files).set(values).where(eq(files.path, path)).run();
	else tx.insert(files).values(values).run();
	tx.insert(revisions)
		.values({ ...values, at })
		.run();
	tx.run(sql`DELETE FROM files_fts WHERE path = ${path}`);
	if (!deleted && path.endsWith(".md"))
		tx.run(
			sql`INSERT INTO files_fts(path, content) VALUES (${path}, ${content ?? ""})`,
		);
	tx.update(meta)
		.set({ value: String(change.seq) })
		.where(eq(meta.key, "head_seq"))
		.run();
	tx.update(meta)
		.set({ value: String(nextLive) })
		.where(eq(meta.key, "live_file_count"))
		.run();
	const epoch = EpochSchema.parse(
		tx
			.select({ value: meta.value })
			.from(meta)
			.where(eq(meta.key, "epoch"))
			.all()[0]?.value,
	);
	return {
		status: prior && prior.deleted === 0 ? 200 : 201,
		body: {
			path,
			etag: formatETag(epoch, revision),
			seq: change.seq,
			hash,
			size,
			deleted,
		},
	};
}

/** Parse canonical nonnegative metadata counters before an increment. */
function parseCounter(value: string | undefined): number {
	if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
		throw new Error("Invalid vault counter");
	const counter = Number(value);
	if (!Number.isSafeInteger(counter)) throw new Error("Unsafe vault counter");
	return counter;
}
