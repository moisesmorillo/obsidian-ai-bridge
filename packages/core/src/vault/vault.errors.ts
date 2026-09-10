/** Raised when a note cannot be represented within the vault payload limit. */
export class NotePayloadTooLargeError extends Error {
  /** Creates the application error for an oversized incoming note. */
  constructor() {
    super("The note payload exceeds the maximum supported size.");
    this.name = "NotePayloadTooLargeError";
  }
}

/** Raised when a storage adapter encounters an oversized persisted note. */
export class StoredNoteTooLargeError extends Error {
  /** Creates the repository error for an oversized persisted object. */
  constructor() {
    super("The stored note exceeds the maximum supported size.");
    this.name = "StoredNoteTooLargeError";
  }
}
