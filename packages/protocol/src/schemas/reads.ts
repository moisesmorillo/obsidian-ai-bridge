import { parseETag } from "@protocol/codecs/etag";
import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Nonnegative safe integer used for vault sequences and byte counts. */
const SafeSequenceSchema = z.number().int().nonnegative().safe();
/** Lowercase hexadecimal SHA-256 digest of live content. */
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Exact vault summary returned before bounded read traversal. */
export const VaultReadResultSchema = z
	.object({
		epoch: EpochSchema,
		head_seq: SafeSequenceSchema,
		counts: z
			.object({ live: SafeSequenceSchema, deleted: SafeSequenceSchema })
			.strict(),
		limits: z
			.object({
				manifest_page: z.literal(256),
				feed_page: z.literal(1000),
				text_bytes: z.literal(1_000_000),
				blob_bytes: z.literal(25_000_000),
			})
			.strict(),
	})
	.strict();

/** One current path row, including tombstones, in the manifest. */
export const ManifestEntrySchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema,
		seq: z.number().int().positive().safe(),
		hash: z.union([Sha256Schema, z.literal("")]),
		size: SafeSequenceSchema,
		kind: z.enum(["text", "blob"]),
		deleted: z.boolean(),
		large: z.boolean(),
	})
	.strict()
	.superRefine((entry, ctx) => {
		if (entry.deleted && (entry.hash !== "" || entry.size !== 0 || entry.large))
			ctx.addIssue({
				code: "custom",
				message: "tombstone manifest metadata must be empty",
			});
		if (!entry.deleted && entry.hash === "")
			ctx.addIssue({
				code: "custom",
				message: "live manifest metadata needs a hash",
			});
		if (
			entry.large &&
			(entry.deleted ||
				entry.kind !== "blob" ||
				entry.size <= 1_000_000 ||
				!/\\.(?:md|canvas)$/i.test(entry.path))
		)
			ctx.addIssue({
				code: "custom",
				message: "large marks only oversized live Markdown or Canvas blobs",
			});
		if (!entry.deleted && entry.hash.length !== 64)
			ctx.addIssue({
				code: "custom",
				message: "live manifest metadata needs a hash",
			});
	});

/** One bounded page of manifest metadata at a captured vault head. */
export const ManifestPageSchema = z
	.object({
		epoch: EpochSchema,
		head_seq: SafeSequenceSchema,
		entries: z.array(ManifestEntrySchema).max(256),
		next_page: z.string().max(4096).nullable(),
	})
	.strict()
	.superRefine((page, ctx) => {
		for (const entry of page.entries)
			if (parseETag(entry.etag).epoch !== page.epoch)
				ctx.addIssue({
					code: "custom",
					message: "manifest ETag epoch does not match page epoch",
				});
		for (let i = 1; i < page.entries.length; i++)
			if (page.entries[i - 1].path >= page.entries[i].path)
				ctx.addIssue({
					code: "custom",
					message: "manifest paths must ascend in binary order",
				});
	});

/** One immutable change row; rename rows include the source tombstone identity. */
export const ChangeEntrySchema = z.discriminatedUnion("op", [
	z
		.object({
			seq: z.number().int().positive().safe(),
			op: z.enum(["put", "delete", "restore"]),
			path: PathSchema,
			etag: ETagSchema,
			hash: z.union([Sha256Schema, z.literal("")]),
			origin: z.string(),
			at: z.number().int().safe(),
		})
		.strict(),
	z
		.object({
			seq: z.number().int().positive().safe(),
			op: z.literal("rename"),
			path: PathSchema,
			etag: ETagSchema,
			hash: Sha256Schema,
			origin: z.string(),
			at: z.number().int().safe(),
			from_path: PathSchema,
			from_etag: ETagSchema,
		})
		.strict()
		.superRefine((entry, ctx) => {
			if (parseETag(entry.etag).epoch !== parseETag(entry.from_etag).epoch)
				ctx.addIssue({
					code: "custom",
					message: "rename ETag epochs must match",
				});
		}),
]);

/** Bounded immutable feed rows captured through one observed head. */
export const ChangesPageSchema = z
	.object({
		epoch: EpochSchema,
		head_seq: SafeSequenceSchema,
		entries: z.array(ChangeEntrySchema).max(1000),
		limit: z.number().int().min(1).max(1000).safe().optional(),
	})
	.strict()
	.superRefine((page, ctx) => {
		let previous = 0;
		for (const entry of page.entries) {
			if (entry.seq <= previous || entry.seq > page.head_seq)
				ctx.addIssue({
					code: "custom",
					message: "change sequence must ascend through the captured head",
				});
			previous = entry.seq;
			if (parseETag(entry.etag).epoch !== page.epoch)
				ctx.addIssue({
					code: "custom",
					message: "change ETag epoch does not match page epoch",
				});
		}
	});

/** One retained history row with public ETag identity and no content. */
export const HistoryPageEntrySchema = z
	.object({
		etag: ETagSchema,
		hash: z.union([Sha256Schema, z.literal("")]),
		size: SafeSequenceSchema,
		deleted: z.boolean(),
		origin: z.string(),
		at: z.number().int().safe(),
	})
	.strict()
	.superRefine((entry, ctx) => {
		if (entry.deleted && (entry.hash !== "" || entry.size !== 0))
			ctx.addIssue({
				code: "custom",
				message: "history tombstone metadata must be empty",
			});
		if (!entry.deleted && entry.hash === "")
			ctx.addIssue({
				code: "custom",
				message: "live history metadata needs a hash",
			});
	});

/** One bounded history page for a single path and captured upper revision. */
export const HistoryPageSchema = z
	.object({
		epoch: EpochSchema,
		entries: z.array(HistoryPageEntrySchema).max(256),
		next_page: z.string().max(4096).nullable(),
	})
	.strict()
	.superRefine((page, ctx) => {
		let previous = 0;
		for (const entry of page.entries) {
			const tag = parseETag(entry.etag);
			if (tag.epoch !== page.epoch || tag.rev <= previous)
				ctx.addIssue({
					code: "custom",
					message: "history ETags must match epoch and ascend",
				});
			previous = tag.rev;
		}
	});

/** Versioned seek payload bound to its collection and snapshot identity. */
export const ReadCursorSchema = z.discriminatedUnion("kind", [
	z
		.object({
			version: z.literal(1),
			kind: z.literal("manifest"),
			epoch: EpochSchema,
			head_seq: SafeSequenceSchema,
			last_path: PathSchema,
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			kind: z.literal("history"),
			epoch: EpochSchema,
			head_seq: SafeSequenceSchema,
			path: PathSchema,
			upper_etag: ETagSchema,
			last_etag: ETagSchema,
		})
		.strict()
		.superRefine((cursor, ctx) => {
			if (
				parseETag(cursor.upper_etag).epoch !== cursor.epoch ||
				parseETag(cursor.last_etag).epoch !== cursor.epoch ||
				parseETag(cursor.last_etag).rev > parseETag(cursor.upper_etag).rev
			)
				ctx.addIssue({
					code: "custom",
					message: "history cursor ETags must fit its epoch and upper bound",
				});
		}),
	z
		.object({
			version: z.literal(1),
			kind: z.literal("changes"),
			epoch: EpochSchema,
			head_seq: SafeSequenceSchema,
			last_seq: SafeSequenceSchema,
		})
		.strict(),
]);

/** Strict read cursor context expected by a route before it uses the seek hint. */
export const ReadCursorContextSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("manifest"), epoch: EpochSchema }).strict(),
	z
		.object({
			kind: z.literal("history"),
			epoch: EpochSchema,
			path: PathSchema,
		})
		.strict(),
	z.object({ kind: z.literal("changes"), epoch: EpochSchema }).strict(),
]);

/** Bounded internal seek request for one metadata collection and captured snapshot. */
export const MetadataBatchRequestSchema = z.discriminatedUnion("collection", [
	z
		.object({
			collection: z.literal("manifest"),
			epoch: EpochSchema,
			head_seq: SafeSequenceSchema,
			after_path: PathSchema.nullable(),
			limit: z.number().int().min(1).max(64).safe(),
		})
		.strict(),
	z
		.object({
			collection: z.literal("history"),
			epoch: EpochSchema,
			path: PathSchema,
			upper_etag: ETagSchema,
			after_rev: SafeSequenceSchema.nullable(),
			limit: z.number().int().min(1).max(64).safe(),
		})
		.strict()
		.superRefine((request, ctx) => {
			if (parseETag(request.upper_etag).epoch !== request.epoch)
				ctx.addIssue({
					code: "custom",
					message: "history batch upper ETag epoch must match",
				});
		}),
	z
		.object({
			collection: z.literal("changes"),
			epoch: EpochSchema,
			head_seq: SafeSequenceSchema,
			after_seq: SafeSequenceSchema,
			limit: z.number().int().min(1).max(64).safe(),
		})
		.strict(),
]);

/** Internal manifest metadata row, without content bytes. */
export const MetadataManifestRowSchema = ManifestEntrySchema;
/** Internal history metadata row, with a numeric seek revision but no content. */
export const MetadataHistoryRowSchema = z
	.object({
		path: PathSchema,
		rev: z.number().int().positive().safe(),
		hash: z.union([Sha256Schema, z.literal("")]),
		size: SafeSequenceSchema,
		deleted: z.boolean(),
		origin: z.string(),
		at: z.number().int().safe(),
	})
	.strict();
/** Internal immutable feed row, with numeric source revision only for SQLite traversal. */
export const MetadataChangeRowSchema = ChangeEntrySchema;
/** Metadata batch can include one lookahead row beyond its requested batch size. */
export const MetadataBatchResultSchema = z
	.object({
		rows: z
			.array(
				z.union([
					MetadataManifestRowSchema,
					MetadataHistoryRowSchema,
					MetadataChangeRowSchema,
				]),
			)
			.max(65),
		next_path: PathSchema.nullable().optional(),
		next_rev: SafeSequenceSchema.nullable().optional(),
		next_seq: SafeSequenceSchema.nullable().optional(),
	})
	.strict();

/** Rejects unrecognized or repeated query values before route policy runs. */
export const ReadQuerySchema = z
	.object({
		page: z.string().max(4096).optional(),
		epoch: EpochSchema.optional(),
		since: z
			.string()
			.regex(/^(?:0|[1-9][0-9]*)$/)
			.refine((value) => Number.isSafeInteger(Number(value)))
			.optional(),
		limit: z
			.string()
			.regex(/^(?:[1-9][0-9]{0,2}|1000)$/)
			.optional(),
	})
	.strict();
