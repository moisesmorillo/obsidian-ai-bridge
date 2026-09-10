import type { NotePath } from "@core/note-path/note-path.types";
import type { WriteNoteResult } from "@core/vault/vault.types";

/**
 * Application operations available to transports that manage vault notes.
 *
 * Implementations own repository orchestration and must not depend on transport APIs.
 */
export interface NoteService {
  /** @returns Normalized paths in deterministic lexical order. */
  list(): Promise<NotePath[]>;

  /**
   * @param path - Normalized note path to read.
   * @returns Note content, or `null` when the note is absent.
   */
  read(path: NotePath): Promise<string | null>;

  /**
   * Stores validated UTF-8 content and reports whether it created a note.
   *
   * @param path - Normalized note path to write.
   * @param content - UTF-8 text content to store.
   * @returns Whether the write created a new note.
   * @throws {NotePayloadTooLargeError} When content exceeds the configured byte limit.
   */
  write(path: NotePath, content: string): Promise<WriteNoteResult>;

  /**
   * @param path - Normalized note path to delete.
   * @returns A promise that settles after the repository applies idempotent deletion.
   */
  delete(path: NotePath): Promise<void>;
}
