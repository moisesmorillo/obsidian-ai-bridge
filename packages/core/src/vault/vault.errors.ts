/** Raised when a note cannot be represented within the vault payload limit. */
export class NotePayloadTooLargeError extends Error {
  constructor() {
    super("The note payload exceeds the maximum supported size.");
    this.name = "NotePayloadTooLargeError";
  }
}

/** Raised when a storage adapter encounters an oversized persisted note. */
export class StoredNoteTooLargeError extends Error {
  constructor() {
    super("The stored note exceeds the maximum supported size.");
    this.name = "StoredNoteTooLargeError";
  }
}
