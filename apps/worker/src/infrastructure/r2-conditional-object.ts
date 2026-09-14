import type { R2ConditionalObjectMetadata } from "@worker/infrastructure/r2.types";

/**
 * Validates metadata needed to identify one exact conditional R2 generation.
 *
 * @param metadata - Metadata returned by an R2 read or successful PUT.
 * @param expectedKey - Exact private key used for the operation.
 * @returns Whether key, ETag, and R2-assigned upload time are usable.
 */
export function isExactR2Generation(
  metadata: R2ConditionalObjectMetadata,
  expectedKey: string,
): boolean {
  return (
    metadata.key === expectedKey &&
    metadata.etag.length > 0 &&
    Number.isFinite(metadata.uploaded.getTime())
  );
}
