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
/** Shared persisted metadata required for every durable operation. */
/** Shared persisted operation fields that bind each key to immutable payload bytes. */
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

/** One persisted step in an idempotent remote apply or its conflict recovery. */
export const PendingApplySchema = z
	.object({
		change: ChangeEntrySchema,
		step: z.enum(["prepared", "named", "copied", "effect_confirmed"]),
		conflict_path: DevicePathSchema.optional(),
		conflict_source: DevicePathSchema.optional(),
		conflict_mode: z.enum(["local", "remote"]).optional(),
		conflict_hash: DevicePayloadHashSchema.optional(),
	})
	.strict()
	.superRefine((pending, context) => {
		if (
			(pending.conflict_path === undefined) !==
				(pending.conflict_hash === undefined) ||
			(pending.conflict_path === undefined) !==
				(pending.conflict_source === undefined) ||
			(pending.conflict_path === undefined) !==
				(pending.conflict_mode === undefined)
		)
			context.addIssue({
				code: "custom",
				message: "Conflict paths and hash must be stored together",
			});
		if (
			(pending.step === "named" || pending.step === "copied") &&
			pending.conflict_path === undefined
		)
			context.addIssue({
				code: "custom",
				message: "Conflict recovery steps need verified identity",
			});
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

/** Durable user-visible blocker for a path that needs explicit resolution. */
export const DeviceAttentionSchema = z
	.object({
		path: DevicePathSchema,
		reason: z.string().min(1),
	})
	.strict();

/** Canonical single-document device journal state for local and remote transitions. */
export const DeviceStateSchema = z
	.object({
		version: z.literal(1),
		device_id: DeviceOperationKeySchema,
		client_id: ClientIdSchema.optional(),
		pending_ops: z
			.array(PendingOperationSchema)
			.refine(
				(operations) =>
					new Set(operations.map((operation) => operation.key)).size ===
					operations.length,
				"Operation keys must be unique",
			),
		base: z.record(DevicePathSchema, DeviceBaseEntrySchema).default({}),
		pending_apply: z.array(PendingApplySchema).max(1).default([]),
		expected_writes: DeviceExpectedWritesSchema.default({}),
		attention: z.array(DeviceAttentionSchema).default([]),
	})
	.strict();

/** Inferred validated local journal state. */
export type DeviceState = z.infer<typeof DeviceStateSchema>;
