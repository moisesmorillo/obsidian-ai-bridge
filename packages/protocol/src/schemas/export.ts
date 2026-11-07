import { EpochSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Maximum current files in one packed baseline manifest. */
export const MAX_EXPORT_FILE_COUNT = 10_000;

/** Accept one millisecond-precise UTC timestamp as the archive idempotency identity. */
const UtcTimestampSchema = z
	.string()
	.datetime({ precision: 3 })
	.refine((value) => new Date(value).toISOString() === value);

/** Canonical manifest stored in `manifest.json` with exact current-file revisions. */
export const ExportManifestSchema = z
	.object({
		epoch: EpochSchema,
		head_seq: z.number().int().nonnegative().safe(),
		created_at: UtcTimestampSchema,
		files: z
			.array(
				z
					.object({
						path: PathSchema,
						rev: z.number().int().positive().safe(),
						hash: z.string().regex(/^[0-9a-f]{64}$/),
						size: z.number().int().nonnegative().safe(),
					})
					.strict(),
			)
			.max(MAX_EXPORT_FILE_COUNT),
	})
	.strict()
	.superRefine((manifest, context) => {
		let totalBytes = 0;
		let previousPath: string | undefined;
		for (const file of manifest.files) {
			if (
				previousPath !== undefined &&
				compareUnicodeCodePoints(file.path, previousPath) <= 0
			)
				context.addIssue({
					code: "custom",
					message: "Export paths must be unique and sorted",
					path: ["files"],
				});
			previousPath = file.path;
			totalBytes += file.size;
			if (!Number.isSafeInteger(totalBytes)) {
				context.addIssue({
					code: "custom",
					message: "Export source byte count exceeds the safe integer range",
					path: ["files"],
				});
				return;
			}
		}
	});

/** Compare NFC vault paths in the same Unicode code-point order as SQLite UTF-8 binary keys. */
function compareUnicodeCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(
		left,
		(character) => character.codePointAt(0) ?? 0,
	);
	const rightPoints = Array.from(
		right,
		(character) => character.codePointAt(0) ?? 0,
	);
	for (
		let index = 0;
		index < Math.min(leftPoints.length, rightPoints.length);
		index += 1
	) {
		const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

/** Start or resume one export under the exact timestamp idempotency identity. */
export const OwnerExportRequestSchema = z
	.object({ created_at: UtcTimestampSchema })
	.strict();

/** Canonical failure kinds stored and returned by the owner export operation. */
export const ExportFailureSchema = z
	.object({
		kind: z.enum([
			"export_storage_unavailable",
			"export_limit_exceeded",
			"export_source_unavailable",
		]),
	})
	.strict();

/** Current export state returned to an owner while alarm batches continue. */
export const ExportOperationResultSchema = z
	.object({
		epoch: EpochSchema,
		created_at: UtcTimestampSchema,
		status: z.enum(["queued", "uploading", "complete", "failed"]),
		size: z.number().int().positive().safe().nullable(),
		failure: ExportFailureSchema.nullable(),
	})
	.strict()
	.superRefine((result, context) => {
		if ((result.status === "complete") !== (result.size !== null))
			context.addIssue({
				code: "custom",
				message: "Only complete exports carry a final size",
				path: ["size"],
			});
		if ((result.status === "failed") !== (result.failure !== null))
			context.addIssue({
				code: "custom",
				message: "Failed exports carry a typed failure",
				path: ["failure"],
			});
	});

/** One completed snapshot with an Access-protected owner download route. */
export const ExportSnapshotSchema = z
	.object({
		epoch: EpochSchema,
		created_at: UtcTimestampSchema,
		size: z.number().int().positive().safe(),
		download_url: z.string().min(1),
	})
	.strict();

/** Canonical completed-snapshot listing returned to the owner console. */
export const ExportSnapshotsSchema = z.array(ExportSnapshotSchema);

/** Validated current-file manifest DTO used by archive restore procedures. */
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
/** Validated asynchronous owner operation state. */
export type ExportOperationResult = z.infer<typeof ExportOperationResultSchema>;
/** Validated persisted or returned export failure. */
export type ExportFailure = z.infer<typeof ExportFailureSchema>;
/** Validated completed owner snapshot and protected download path. */
export type ExportSnapshot = z.infer<typeof ExportSnapshotSchema>;
