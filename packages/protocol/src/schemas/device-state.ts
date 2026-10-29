import { ClientIdSchema } from "@protocol/schemas/auth";
import { EpochSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { ChangeEntrySchema } from "@protocol/schemas/reads";
import { z } from "zod";

/** UUIDv7 keys identify one immutable operation instance and its payload path. */
export const DeviceOperationKeySchema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);

/** Validates a canonical path without normalizing persisted operation metadata. */
const DevicePathSchema = z.string().superRefine((path, context) => {
	const parsed = PathSchema.safeParse(path);
	if (!parsed.success || parsed.data !== path)
		context.addIssue({
			code: "custom",
			message: "Path must be valid and NFC-normalized",
		});
});

/** Validates an exact server precondition without deriving revisions from local state. */
export const DevicePreconditionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("absent") }).strict(),
	z
		.object({
			kind: z.literal("match"),
			epoch: EpochSchema,
			rev: z.number().int().positive().safe(),
		})
		.strict(),
]);

/** Inferred exact observed precondition accepted by a device operation. */
export type DevicePrecondition = z.infer<typeof DevicePreconditionSchema>;

/** Canonical excluded directory for immutable operation payloads. */
export const DEVICE_PAYLOAD_DIRECTORY = ".ai-bridge/pending/";

/** Validates one UUIDv7 payload reference inside the excluded journal directory. */
export const DevicePayloadReferenceSchema = z
	.string()
	.superRefine((reference, context) => {
		const key = reference.startsWith(DEVICE_PAYLOAD_DIRECTORY)
			? reference.slice(DEVICE_PAYLOAD_DIRECTORY.length)
			: "";
		if (!DeviceOperationKeySchema.safeParse(key).success) {
			context.addIssue({
				code: "custom",
				message: "Invalid device payload path",
			});
		}
	});

/** Validates the byte digest used to detect payload corruption before release. */
export const DevicePayloadHashSchema = z.string().regex(/^[0-9a-f]{64}$/i);
/** Shared persisted fields bind each key to immutable payload bytes and retry state. */
const commonOperationShape = {
	key: DeviceOperationKeySchema,
	payload_hash: DevicePayloadHashSchema,
	payload_ref: DevicePayloadReferenceSchema,
	created_at: z.number().int().nonnegative(),
	attempts: z.number().int().nonnegative(),
	state: z.enum(["queued", "sent", "resolved"]),
};

/** Canonical validated persistence contract for one put/delete/rename operation. */
export const PendingOperationSchema = z
	.discriminatedUnion("op", [
		z
			.object({
				...commonOperationShape,
				op: z.literal("put"),
				path: DevicePathSchema,
				precondition: DevicePreconditionSchema,
			})
			.strict(),
		z
			.object({
				...commonOperationShape,
				op: z.literal("delete"),
				path: DevicePathSchema,
				precondition: DevicePreconditionSchema,
			})
			.strict(),
		z
			.object({
				...commonOperationShape,
				op: z.literal("rename"),
				path: DevicePathSchema,
				to: DevicePathSchema,
				precondition: DevicePreconditionSchema,
			})
			.strict(),
	])
	.superRefine((operation, context) => {
		if (operation.op === "rename" && operation.path === operation.to) {
			context.addIssue({
				code: "custom",
				message: "Rename source and destination must differ",
				path: ["to"],
			});
		}
		if (operation.payload_ref !== `.ai-bridge/pending/${operation.key}`) {
			context.addIssue({
				code: "custom",
				message: "Payload reference must match its operation key",
			});
		}
	});

/** Inferred persisted operation type; callers must preserve every sent field exactly. */
export type PendingOperation = z.infer<typeof PendingOperationSchema>;

/** A server revision confirmed at one canonical path, or its confirmed tombstone. */
export const DeviceBaseEntrySchema = z.discriminatedUnion("deleted", [
	z
		.object({
			deleted: z.literal(false),
			rev: z.number().int().positive().safe(),
			hash: DevicePayloadHashSchema,
		})
		.strict(),
	z
		.object({
			deleted: z.literal(true),
			rev: z.number().int().positive().safe(),
		})
		.strict(),
]);

/** One local or remote copy plan. Verified marks a visible remote copy that rebasing must preserve. */
export const PendingConflictCopySchema = z
	.object({
		path: DevicePathSchema,
		source: DevicePathSchema,
		side: z.enum(["path", "rename_source", "rename_destination"]),
		mode: z.enum(["local", "remote"]),
		device_name: z.string().min(1).optional(),
		verified: z.boolean().optional(),
		hash: DevicePayloadHashSchema,
	})
	.strict();

/** Inferred identity for one durably preserved local or remote version. */
export type PendingConflictCopy = z.infer<typeof PendingConflictCopySchema>;

/** One durable apply step with legacy or per-side conflict-copy recovery metadata. */
export const PendingApplySchema = z
	.object({
		change: ChangeEntrySchema,
		step: z.enum(["prepared", "named", "copied"]),
		conflict_path: DevicePathSchema.optional(),
		conflict_source: DevicePathSchema.optional(),
		conflict_mode: z.enum(["local", "remote"]).optional(),
		conflict_device_name: z.string().min(1).optional(),
		conflict_hash: DevicePayloadHashSchema.optional(),
		conflict_copies: z
			.array(PendingConflictCopySchema)
			.min(1)
			.max(2)
			.optional(),
	})
	.strict()
	.superRefine((pending, context) => {
		const legacyFields = [
			pending.conflict_path,
			pending.conflict_source,
			pending.conflict_mode,
			pending.conflict_hash,
		];
		const hasLegacyIdentity = pending.conflict_path !== undefined;
		const hasConflictCopies = pending.conflict_copies !== undefined;
		if (
			legacyFields.some((field) => field !== undefined) &&
			legacyFields.some((field) => field === undefined)
		)
			context.addIssue({
				code: "custom",
				message: "Legacy conflict identity fields must be stored together",
			});
		if (hasConflictCopies && legacyFields.some((field) => field !== undefined))
			context.addIssue({
				code: "custom",
				message: "Conflict copies cannot mix legacy and per-side identity",
			});
		const hasConflict = hasLegacyIdentity || hasConflictCopies;
		if ((pending.step === "named" || pending.step === "copied") !== hasConflict)
			context.addIssue({
				code: "custom",
				message: "Conflict identity must match the persisted apply step",
			});
		if (pending.conflict_device_name !== undefined && !hasLegacyIdentity)
			context.addIssue({
				code: "custom",
				message: "Legacy conflict names need legacy conflict identity",
			});
		if (hasLegacyIdentity && pending.conflict_mode === "remote") {
			if (pending.change.op !== "put")
				context.addIssue({
					code: "custom",
					message: "Remote collision copies only support put entries",
				});
			if (pending.conflict_hash !== pending.change.hash)
				context.addIssue({
					code: "custom",
					message: "Remote conflict hash must match the pinned put hash",
				});
		}
		if (pending.conflict_copies) {
			const seenPaths = new Set<string>();
			for (const [index, copy] of pending.conflict_copies.entries()) {
				if (seenPaths.has(copy.path))
					context.addIssue({
						code: "custom",
						message: "Conflict copy paths and sources must be unique",
						path: ["conflict_copies", index],
					});
				seenPaths.add(copy.path);
				if (copy.mode === "remote") {
					if (pending.change.op !== "put")
						context.addIssue({
							code: "custom",
							message: "Remote collision copies only support put entries",
							path: ["conflict_copies", index, "mode"],
						});
					if (copy.hash !== pending.change.hash && copy.verified !== true)
						context.addIssue({
							code: "custom",
							message: "Remote conflict hash must match the pinned put hash",
							path: ["conflict_copies", index, "hash"],
						});
				}
				const validSide =
					pending.change.op === "rename"
						? (copy.side === "rename_source" &&
								copy.source === pending.change.from_path) ||
							(copy.side === "rename_destination" &&
								copy.source === pending.change.path)
						: copy.side === "path" && copy.source === pending.change.path;
				if (!validSide)
					context.addIssue({
						code: "custom",
						message: "Conflict-copy side must match its operation path",
						path: ["conflict_copies", index, "side"],
					});
			}
		}
	});

/** Inferred validated step for resumable remote apply. */
export type PendingApply = z.infer<typeof PendingApplySchema>;
/** Inferred confirmed local base state for one remote path. */
export type DeviceBaseEntry = z.infer<typeof DeviceBaseEntrySchema>;

/** Expected local echo hashes are separate from confirmed base revisions. */
export const DeviceExpectedWritesSchema = z.record(
	DevicePathSchema,
	DevicePayloadHashSchema,
);

/** Saved snapshot, page progress, remote paths, and local phase for safe restart. */
export const ReconciliationCheckpointSchema = z
	.object({
		epoch: EpochSchema,
		head_seq: z.number().int().nonnegative().safe(),
		stage: z.enum(["manifest", "local", "cursor"]).optional(),
		page_token: z.string().max(4096).nullable(),
		page_number: z.number().int().nonnegative().safe(),
		local_paths: z.array(DevicePathSchema),
		local_index: z.number().int().nonnegative().safe(),
		pending_paths: z.array(DevicePathSchema),
		remote_paths: z.array(DevicePathSchema).optional(),
	})
	.strict()
	.transform((checkpoint) => {
		const needsRemotePathMigration = checkpoint.remote_paths === undefined;
		return {
			...checkpoint,
			stage: needsRemotePathMigration
				? "manifest"
				: (checkpoint.stage ??
					(checkpoint.page_number > 0 &&
					checkpoint.page_token === null &&
					checkpoint.pending_paths.length === 0
						? "local"
						: "manifest")),
			page_token: needsRemotePathMigration ? null : checkpoint.page_token,
			page_number: needsRemotePathMigration ? 0 : checkpoint.page_number,
			pending_paths: needsRemotePathMigration ? [] : checkpoint.pending_paths,
			remote_paths: checkpoint.remote_paths ?? [],
		};
	})
	.superRefine((checkpoint, context) => {
		if (checkpoint.local_index > checkpoint.local_paths.length)
			context.addIssue({
				code: "custom",
				message: "Local scan offset exceeds its saved path list",
			});
	});

/** Inferred durable manifest traversal and local enrollment progress. */
export type ReconciliationCheckpoint = z.infer<
	typeof ReconciliationCheckpointSchema
>;

/** Durable user-visible blocker; old-epoch operations retain full retry identity. */
export const DeviceAttentionSchema = z
	.object({
		path: DevicePathSchema,
		reason: z.string().min(1),
		operation: PendingOperationSchema.optional(),
	})
	.strict();

/** Canonical single-document device journal state for local and remote transitions. */
export const DeviceStateSchema = z
	.object({
		version: z.literal(1),
		device_id: DeviceOperationKeySchema,
		client_id: ClientIdSchema.optional(),
		epoch: EpochSchema.optional(),
		cursor: z.number().int().nonnegative().safe().nullable().default(null),
		pending_ops: z
			.array(PendingOperationSchema)
			.refine(
				(operations) =>
					new Set(operations.map((operation) => operation.key)).size ===
					operations.length,
				"Operation keys must be unique",
			),
		base: z.record(DevicePathSchema, DeviceBaseEntrySchema).default({}),
		stale_base_paths: z.array(DevicePathSchema).default([]),
		pending_apply: z.array(PendingApplySchema).max(1).default([]),
		expected_writes: DeviceExpectedWritesSchema.default({}),
		reconciliation: ReconciliationCheckpointSchema.nullable().default(null),
		attention: z.array(DeviceAttentionSchema).default([]),
	})
	.strict();

/** Inferred validated local journal state. */
export type DeviceState = z.infer<typeof DeviceStateSchema>;
