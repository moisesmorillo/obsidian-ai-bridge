import type { NotePath } from "@core/note-path/note-path.types";
import type { NoteService } from "@core/vault/note-service.types";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";
import { NotePayloadTooLargeError } from "@core/vault/vault.errors";
import type { WriteNoteResult } from "@core/vault/vault.types";
import type { VaultRepository } from "@core/vault/vault-repository.port";

/**
 * Repository-backed implementation of the note application service.
 *
 * This class is the only core layer that coordinates repository calls for M1 notes.
 */
export class VaultNoteService implements NoteService {
  /**
   * Creates a note service over a storage port.
   *
   * @param repository - Storage port used to persist normalized note paths and content.
   */
  constructor(private readonly repository: VaultRepository) {}

  /**
   * Lists notes in deterministic lexical order.
   *
   * @returns A sorted copy of normalized paths returned by the repository.
   */
  async list(): Promise<NotePath[]> {
    return [...(await this.repository.list())].sort();
  }

  /**
   * Reads a note through the storage port.
   *
   * @param path - Validated note path to read.
   * @returns The note content, or `null` when it is absent.
   */
  read(path: NotePath): Promise<string | null> {
    return this.repository.read(path);
  }

  /**
   * Validates size and stores UTF-8 note content.
   *
   * @param path - Validated note path to write.
   * @param content - UTF-8 text content to store.
   * @returns Whether the write created a new note.
   * @throws {NotePayloadTooLargeError} When UTF-8 content exceeds `MAX_NOTE_SIZE_BYTES`.
   */
  async write(path: NotePath, content: string): Promise<WriteNoteResult> {
    if (new TextEncoder().encode(content).byteLength > MAX_NOTE_SIZE_BYTES) {
      throw new NotePayloadTooLargeError();
    }

    const created = !(await this.repository.exists(path));
    await this.repository.write(path, content);
    return { created };
  }

  /**
   * Deletes a note through the storage port.
   *
   * @param path - Validated note path to delete.
   * @returns A promise that settles after the repository applies its delete semantics.
   */
  delete(path: NotePath): Promise<void> {
    return this.repository.delete(path);
  }
}
