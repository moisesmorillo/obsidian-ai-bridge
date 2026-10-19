import { OperationIntentSchema } from "@protocol/schemas/admission";
import { FullTextContentSchema } from "@protocol/schemas/content";
import { EpochSchema } from "@protocol/schemas/etag";
import { MutationReceiptSchema } from "@protocol/schemas/files";
import { IdempotencyKeySchema } from "@protocol/schemas/idempotency";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Strict rename body with an NFC-normalized destination path. */
export const RenameRequestSchema = z.object({ to: PathSchema }).strict();

/** Strict restore body for one retained positive path revision. */
export const RestoreRequestSchema = z
	.object({
		source_rev: z.number().int().positive().safe(),
		as_conflict_copy: z.boolean().optional(),
	})
	.strict();

/** Current-vault history query without revision content. */
export const HistoryRequestSchema = z
	.object({
		path: PathSchema,
		epoch: EpochSchema.optional(),
	})
	.strict();

/** One retained history metadata entry, without content bytes. */
export const HistoryEntrySchema = z
	.object({
		rev: z.number().int().positive().safe(),
		hash: z.string().regex(/^(?:[0-9a-f]{64})?$/),
		size: z.number().int().nonnegative().safe(),
		deleted: z.boolean(),
		origin: z.string(),
		at: z.number().int().safe(),
	})
	.strict()
	.superRefine((entry, ctx) => {
		if (entry.deleted && (entry.hash !== "" || entry.size !== 0)) {
			ctx.addIssue({
				code: "custom",
				message: "tombstone history metadata must be empty",
			});
		}
		if (!entry.deleted && entry.hash.length !== 64) {
			ctx.addIssue({
				code: "custom",
				message: "live history metadata needs a hash",
			});
		}
	});

/** Ascending retained history metadata for one path. */
export const HistoryResultSchema = z
	.array(HistoryEntrySchema)
	.superRefine((entries, ctx) => {
		for (let index = 1; index < entries.length; index += 1) {
			if (entries[index - 1].rev >= entries[index].rev) {
				ctx.addIssue({
					code: "custom",
					message: "history revisions must ascend",
				});
				return;
			}
		}
	});

/** Strict history commands paired with canonical admission metadata. */
export const FileCommandSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("rename"),
			intent: OperationIntentSchema.safeExtend({ op: z.literal("rename") }),
			body: RenameRequestSchema,
			key: IdempotencyKeySchema.optional(),
		})
		.strict()
		.superRefine((command, ctx) => {
			if (
				command.intent.paths.length !== 2 ||
				command.body.to !== command.intent.paths[1]
			) {
				ctx.addIssue({
					code: "custom",
					message: "rename command paths do not match its body",
				});
			}
		}),
	z
		.object({
			op: z.literal("append"),
			intent: OperationIntentSchema.safeExtend({ op: z.literal("append") }),
			content: FullTextContentSchema,
			key: IdempotencyKeySchema,
		})
		.strict()
		.superRefine((command, ctx) => {
			if (
				command.intent.paths.length !== 1 ||
				command.intent.precondition.kind !== "none" ||
				command.intent.epoch === undefined
			) {
				ctx.addIssue({
					code: "custom",
					message: "append command intent is invalid",
				});
			}
		}),
	z
		.object({
			op: z.literal("restore"),
			intent: OperationIntentSchema.safeExtend({ op: z.literal("restore") }),
			body: RestoreRequestSchema,
			key: IdempotencyKeySchema.optional(),
		})
		.strict()
		.superRefine((command, ctx) => {
			if (command.intent.paths.length !== 1) {
				ctx.addIssue({
					code: "custom",
					message: "restore command needs one path",
				});
			}
		}),
]);

/** Successful rename response. Its receipt path identifies the destination. */
export const RenameResultSchema = z
	.object({ response: MutationReceiptSchema })
	.strict();
