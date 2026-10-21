import type {
	BlobAuthorizationResultSchema,
	BlobDeclarationSchema,
	BlobMetadataSchema,
} from "@protocol/schemas/blobs";
import type { z } from "zod";

/** Exact declared digest and byte count for one uploaded body. */
export type BlobDeclaration = z.infer<typeof BlobDeclarationSchema>;
/** Authorized immutable metadata for a blob-backed file revision. */
export type BlobMetadata = z.infer<typeof BlobMetadataSchema>;

/** Complete blob authority result before immutable content effects. */
export type BlobAuthorizationResult = z.infer<
	typeof BlobAuthorizationResultSchema
>;
