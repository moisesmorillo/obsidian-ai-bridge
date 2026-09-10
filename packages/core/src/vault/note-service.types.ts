import type { NotePath } from "@core/note-path/note-path.types";
import type { WriteNoteResult } from "@core/vault/vault.types";

/**
 * Application operations available to transports that manage vault notes.
 *
 * Implementations own repository orchestration and must not depend on transport APIs.
 */
export interface NoteService {
  /** Lists normalized paths in deterministic lexical order. */
  list(): Promise<NotePath[]>;

  /** Reads a note, returning `null` when it is absent. */
  read(path: NotePath): Promise<string | null>;

  /**
   * Stores validated UTF-8 content and reports whether it created a note.
   *
   * @throws {NotePayloadTooLargeError} When content exceeds the configured byte limit.
   */
  write(path: NotePath, content: string): Promise<WriteNoteResult>;

  /** Deletes a note using the repository's idempotent semantics. */
  delete(path: NotePath): Promise<void>;
}
