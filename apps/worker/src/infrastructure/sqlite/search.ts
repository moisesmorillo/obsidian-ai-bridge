import type {
	AuthorizationContext,
	SearchRequest,
	SearchResult,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	formatETag,
	SearchRequestSchema,
	SearchResultSchema,
} from "@obsidian-ai-bridge/protocol";
import { prepareOperation } from "@worker/application/admission";
import type { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { assertPolicyInTransaction } from "@worker/infrastructure/sqlite/admission";
import {
	files,
	meta,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Drizzle mapping for the existing FTS5 table at its engine-specific seam. */
const filesFts = sqliteTable("files_fts", {
	path: text("path"),
	content: text("content"),
});

/** Select literal FTS results and matching coverage in one synchronous SQLite transaction. */
export class SqliteSearchStore {
	private readonly db;

	/** Bind native storage and the existing admission authority. */
	constructor(
		storage: DurableObjectStorage,
		private readonly admissions: SqliteAdmissionAuthority,
	) {
		this.db = drizzle(storage, { schema: { ...vaultSchema, filesFts } });
	}

	/** Return ranked bounded results after current policy and ticket checks. */
	async search(
		context: AuthorizationContext,
		request: SearchRequest,
		admissionId: string,
	): Promise<SearchResult> {
		const parsed = SearchRequestSchema.parse(request);
		const operation = await prepareOperation(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		return this.db.transaction((tx) => {
			this.admissions.assertActiveTicketInTransaction(
				tx,
				context,
				operation,
				admissionId,
			);
			assertPolicyInTransaction(tx, context, {
				client_id: context.client_id,
				descriptor: {
					op: "read",
					paths: [],
					precondition: { kind: "none" },
				},
				descriptorFingerprint: "",
			});
			const epoch = tx
				.select({ value: meta.value })
				.from(meta)
				.where(eq(meta.key, "epoch"))
				.all()[0]?.value;
			if (!epoch) throw new Error("Missing vault epoch");
			const phrase = `"${parsed.query.replaceAll('"', '""')}"`;
			const rows = tx
				.select({
					path: files.path,
					rev: files.rev,
					snippet: sql<string>`substr(snippet(${filesFts}, 1, '', '', '…', 64), 1, 1024)`,
					score: sql<number>`bm25(${filesFts})`,
				})
				.from(filesFts)
				.innerJoin(files, eq(files.path, filesFts.path))
				.where(
					and(
						sql`${filesFts} MATCH ${phrase}`,
						eq(files.deleted, 0),
						eq(files.kind, "text"),
						sql`substr(${files.path}, -3) = '.md'`,
					),
				)
				.orderBy(sql`bm25(${filesFts})`, sql`${files.path} COLLATE BINARY`)
				.limit(parsed.limit)
				.all();
			const indexed =
				tx
					.select({ count: sql<number>`count(*)` })
					.from(filesFts)
					.innerJoin(files, eq(files.path, filesFts.path))
					.where(
						and(
							eq(files.deleted, 0),
							eq(files.kind, "text"),
							sql`substr(${files.path}, -3) = '.md'`,
						),
					)
					.all()[0]?.count ?? 0;
			const large =
				tx
					.select({ count: sql<number>`count(*)` })
					.from(files)
					.where(
						and(
							eq(files.deleted, 0),
							eq(files.kind, "blob"),
							sql`${files.size} > 1000000`,
							sql`substr(${files.path}, -3) = '.md'`,
						),
					)
					.all()[0]?.count ?? 0;
			return SearchResultSchema.parse({
				epoch,
				results: rows.map((row) => ({
					path: row.path,
					etag: formatETag(epoch, row.rev),
					snippet: row.snippet,
					score: row.score,
				})),
				indexed_files: indexed,
				unindexed_large_files: large,
			});
		});
	}
}
