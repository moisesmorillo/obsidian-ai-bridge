import { ClientIdSchema } from "@protocol/schemas/auth";
import { EpochSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
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

/** Canonical single-document device journal state for this journal-only delivery. */
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
	})
	.strict();

/** Inferred validated local journal state. */
export type DeviceState = z.infer<typeof DeviceStateSchema>;
