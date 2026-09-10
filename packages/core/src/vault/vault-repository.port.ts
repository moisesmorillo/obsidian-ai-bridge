import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Port implemented by storage adapters that persist normalized Markdown notes.
 *
 * Adapters own storage namespaces and platform details; callers provide only
 * paths that already satisfy the core note-path invariant.
 */
export interface VaultRepository {
  /** @returns All stored normalized note paths visible to the vault. */
  list(): Promise<readonly NotePath[]>;

  /**
   * @param path - Normalized note path to inspect.
   * @returns Whether a note currently exists at the path.
   */
  exists(path: NotePath): Promise<boolean>;

  /**
   * @param path - Normalized note path to read.
   * @returns Note content, or `null` when the path is absent.
   */
  read(path: NotePath): Promise<string | null>;

  /**
   * @param path - Normalized note path to write.
   * @param content - UTF-8 note content to persist.
   * @returns A promise that settles after the content is stored.
   */
  write(path: NotePath, content: string): Promise<void>;

  /**
   * @param path - Normalized note path to delete.
   * @returns A promise that settles after an idempotent deletion attempt.
   */
  delete(path: NotePath): Promise<void>;
}
