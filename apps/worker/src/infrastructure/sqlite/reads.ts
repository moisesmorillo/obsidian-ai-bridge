import type {
	AuthorizationContext,
	MetadataBatchRequest,
	MetadataBatchResult,
	VaultReadResult,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	formatETag,
	MetadataBatchRequestSchema,
	MetadataBatchResultSchema,
	PathSchema,
	parseETag,
	VaultReadResultSchema,
} from "@obsidian-ai-bridge/protocol";
import { prepareOperation } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import type {
	SqliteAdmissionAuthority,
	VaultTransaction,
} from "@worker/infrastructure/sqlite/admission";
import { assertPolicyInTransaction } from "@worker/infrastructure/sqlite/admission";
import {
	readCapacitySummary,
	readCounter,
} from "@worker/infrastructure/sqlite/capacity";
import {
	changes,
	files,
	meta,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Read bounded metadata batches from SQLite without selecting content columns. */
export class SqliteReadStore {
	private readonly db;

	/** Bind the vault database and clock used for exact 30-day feed eligibility. */
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly admissions: SqliteAdmissionAuthority,
		private readonly ports: { now: () => number; logger?: Logger },
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger: ports.logger });
	}

	/** Return aggregate counts and published limits after native read policy checks. */
	async readVault(
		context: AuthorizationContext,
		admissionId: string,
	): Promise<VaultReadResult> {
		const operation = await prepareOperation(
			context,
			readIntent([], undefined),
		);
		return this.db.transaction((tx) => {
			this.admissions.assertActiveTicketInTransaction(
				tx,
				context,
				operation,
				admissionId,
			);
			assertVaultReadPolicy(tx, context);
			const epoch = readMeta(tx, "epoch");
			const head = Number(readMeta(tx, "head_seq"));
			const counts = tx
				.select({
					live: sql<number>`sum(case when ${files.deleted} = 0 then 1 else 0 end)`,
					deleted: sql<number>`sum(case when ${files.deleted} = 1 then 1 else 0 end)`,
				})
				.from(files)
				.all()[0];
			return VaultReadResultSchema.parse({
				epoch,
				head_seq: head,
				counts: { live: counts?.live ?? 0, deleted: counts?.deleted ?? 0 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				...readCapacitySummary(tx, this.storage),
			});
		});
	}

	/** Capture the current history ceiling without loading retained revision rows. */
	async readHistoryUpper(
		context: AuthorizationContext,
		admissionId: string,
		path: string,
	) {
		const operation = await prepareOperation(
			context,
			readIntent([path], undefined),
		);
		return this.db.transaction((tx) => {
			this.admissions.assertActiveTicketInTransaction(
				tx,
				context,
				operation,
				admissionId,
			);
			const epoch = assertVaultReadPolicy(tx, context, undefined, path);
			const row = tx
				.select({ rev: files.rev })
				.from(files)
				.where(eq(files.path, path))
				.all()[0];
			return {
				epoch,
				head_seq: Number(readMeta(tx, "head_seq")),
				upper_etag: row ? formatETag(epoch, row.rev) : null,
			};
		});
	}

	/** Read at most 64 metadata rows and one lookahead row for one collection. */
	async readBatch(
		context: AuthorizationContext,
		request: MetadataBatchRequest,
		admissionId: string,
	): Promise<MetadataBatchResult> {
		const parsed = MetadataBatchRequestSchema.parse(request);
		const paths = parsed.collection === "history" ? [parsed.path] : [];
		const operation = await prepareOperation(
			context,
			readIntent(paths, undefined),
		);
		return this.db.transaction((tx) => {
			assertVaultReadPolicy(
				tx,
				context,
				parsed.epoch,
				parsed.collection === "history" ? parsed.path : undefined,
			);
			this.admissions.assertActiveTicketInTransaction(
				tx,
				context,
				operation,
				admissionId,
			);
			const authoritativeHead = Number(readMeta(tx, "head_seq"));
			if (
				parsed.collection !== "history" &&
				parsed.head_seq > authoritativeHead
			)
				throw new FileOperationDenied({ kind: "invalid_request" });
			if (parsed.collection === "manifest") {
				if (parsed.head_seq < feedFloor(tx, this.ports.now()) - 1)
					throw new FileOperationDenied({ kind: "cursor_expired" });
				const afterPath = parsed.after_path;
				const query = tx
					.select({
						path: files.path,
						rev: files.rev,
						seq: files.seq,
						hash: files.hash,
						size: files.size,
						kind: files.kind,
						deleted: files.deleted,
					})
					.from(files)
					.$dynamic();
				const rows = (
					afterPath === null ? query : query.where(gt(files.path, afterPath))
				)
					.orderBy(asc(files.path))
					.limit(parsed.limit + 1)
					.all();
				return MetadataBatchResultSchema.parse({
					collection: "manifest",
					rows: rows.map((row) => ({
						path: PathSchema.parse(row.path),
						etag: formatETag(parsed.epoch, row.rev),
						seq: row.seq,
						hash: row.deleted ? "" : row.hash,
						size: row.deleted ? 0 : row.size,
						kind: row.kind,
						deleted: row.deleted === 1,
						large:
							row.deleted === 0 &&
							row.kind === "blob" &&
							row.size > 1_000_000 &&
							typeof row.path === "string" &&
							(row.path.toLowerCase().endsWith(".md") ||
								row.path.toLowerCase().endsWith(".canvas")),
					})),
				});
			}
			if (parsed.collection === "history") {
				const upper = parseETag(parsed.upper_etag).rev;
				const current = tx
					.select({ rev: files.rev })
					.from(files)
					.where(eq(files.path, parsed.path))
					.all()[0];
				if (!current || upper > current.rev)
					throw new FileOperationDenied({ kind: "invalid_request" });
				const rows = tx
					.select({
						path: revisions.path,
						rev: revisions.rev,
						hash: revisions.hash,
						size: revisions.size,
						deleted: revisions.deleted,
						origin: revisions.origin,
						at: revisions.at,
					})
					.from(revisions)
					.where(
						and(
							eq(revisions.path, parsed.path),
							gt(revisions.rev, parsed.after_rev ?? 0),
							lte(revisions.rev, upper),
						),
					)
					.orderBy(asc(revisions.rev))
					.limit(parsed.limit + 1)
					.all();
				return MetadataBatchResultSchema.parse({
					collection: "history",
					rows: rows.map((row) => ({
						...row,
						hash: row.deleted ? "" : row.hash,
						size: row.deleted ? 0 : row.size,
						deleted: row.deleted === 1,
					})),
				});
			}
			if (parsed.after_seq > parsed.head_seq)
				throw new FileOperationDenied({ kind: "invalid_request" });
			const floor = feedFloor(tx, this.ports.now());
			if (parsed.after_seq < floor - 1)
				throw new FileOperationDenied({ kind: "cursor_expired" });
			const rows = tx
				.select({
					seq: changes.seq,
					op: changes.op,
					path: changes.path,
					rev: changes.rev,
					hash: changes.hash,
					from_path: changes.fromPath,
					from_rev: changes.fromRev,
					origin: changes.origin,
					at: changes.at,
				})
				.from(changes)
				.where(
					and(
						gt(changes.seq, parsed.after_seq),
						lte(changes.seq, parsed.head_seq),
					),
				)
				.orderBy(asc(changes.seq))
				.limit(parsed.limit + 1)
				.all();
			return MetadataBatchResultSchema.parse({
				collection: "changes",
				rows: rows.map((row) => ({
					seq: row.seq,
					op: row.op,
					path: row.path,
					etag: formatETag(parsed.epoch, row.rev),
					hash: row.op === "delete" ? "" : row.hash,
					origin: row.origin,
					at: row.at,
					...(row.op === "rename" && row.from_path && row.from_rev !== null
						? {
								from_path: row.from_path,
								from_etag: formatETag(parsed.epoch, row.from_rev),
							}
						: {}),
				})),
			});
		});
	}
}

/** Build the canonical body-free intent that binds a read ticket to its scope and epoch. */
function readIntent(paths: string[], epoch: string | undefined) {
	return {
		op: "read" as const,
		paths,
		precondition: { kind: "none" as const },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
		...(epoch === undefined ? {} : { epoch }),
	};
}

/** Check read scope, revocation, and optional observed epoch in the current transaction. */
function assertVaultReadPolicy(
	tx: VaultTransaction,
	context: AuthorizationContext,
	epoch?: string,
	path?: string,
): string {
	const descriptor = {
		op: "read" as const,
		paths: path ? [path] : [],
		precondition: { kind: "none" as const },
		...(epoch ? { epoch } : {}),
	};
	return assertPolicyInTransaction(tx, context, {
		client_id: context.client_id,
		descriptor,
		descriptorFingerprint: "",
	});
}

/** Read one required metadata value and fail closed when the vault schema is incomplete. */
function readMeta(tx: VaultTransaction, key: string): string {
	const row = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, key))
		.all()[0];
	if (!row) throw new Error(`Missing vault metadata: ${key}`);
	return row.value;
}

/** Use the inclusive 30-day Unix-millisecond cutoff for feed availability. Rows at the cutoff remain available.
 * Raise the sequence floor past every expired row so clock rollback cannot expose an expired later entry.
 */
function feedFloor(tx: VaultTransaction, now: number): number {
	const cutoff = now - 30 * 24 * 60 * 60 * 1000;
	const boundary = tx
		.select({
			firstRetained: sql<
				number | null
			>`min(case when ${changes.at} >= ${cutoff} then ${changes.seq} end)`,
			lastExpired: sql<
				number | null
			>`max(case when ${changes.at} < ${cutoff} then ${changes.seq} end)`,
		})
		.from(changes)
		.all()[0];
	const head = Number(readMeta(tx, "head_seq"));
	if (head === 0) return 0;
	const firstRetained = boundary?.firstRetained ?? null;
	const lastExpired = boundary?.lastExpired ?? null;
	const retainedFloor = firstRetained ?? 0;
	const expiryFloor = lastExpired === null ? 0 : lastExpired + 1;
	const timeDerivedFloor = Math.max(retainedFloor, expiryFloor);
	const prunedFloor = readCounter(tx, "retention_pruned_feed_seq");
	return Math.max(timeDerivedFloor, prunedFloor);
}
