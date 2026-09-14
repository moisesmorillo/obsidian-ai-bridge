/** Closed causes for rejecting persisted mirror data at the storage boundary. */
export const STORED_OBJECT_DATA_ERROR_KIND = {
  malformed: "malformed",
  unsupportedFormat: "unsupported-format",
  contentHashMismatch: "content-hash-mismatch",
  tooLarge: "too-large",
} as const;

/** Typed cause for invalid, unsupported, or inconsistent persisted mirror data. */
export type StoredObjectDataErrorKind =
  (typeof STORED_OBJECT_DATA_ERROR_KIND)[keyof typeof STORED_OBJECT_DATA_ERROR_KIND];

/** Raised when persisted bytes cannot be safely interpreted as their tagged format. */
export class StoredObjectDataError extends Error {
  /**
   * Creates a sanitized storage/data failure without embedding object bytes.
   *
   * @param kind - Stable category suitable for application failure mapping.
   */
  constructor(readonly kind: StoredObjectDataErrorKind) {
    super(`Stored mirror object is ${kind}.`);
    this.name = "StoredObjectDataError";
  }
}
