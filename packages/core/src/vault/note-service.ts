import type { NotePath } from "@core/note-path/note-path.types";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";
import { NotePayloadTooLargeError } from "@core/vault/vault.errors";
import type { WriteNoteResult } from "@core/vault/vault.types";
import type { VaultRepository } from "@core/vault/vault-repository.port";

/** Lists normalized note paths in deterministic lexical order. */
export async function listNotes(
  repository: VaultRepository,
): Promise<NotePath[]> {
  return [...(await repository.list())].sort();
}

/** Reads one note without introducing storage-specific behavior. */
export function readNote(
  repository: VaultRepository,
  path: NotePath,
): Promise<string | null> {
  return repository.read(path);
}

/** Writes a note after enforcing the domain payload-size invariant. */
export async function writeNote(
  repository: VaultRepository,
  path: NotePath,
  content: string,
): Promise<WriteNoteResult> {
  if (new TextEncoder().encode(content).byteLength > MAX_NOTE_SIZE_BYTES) {
    throw new NotePayloadTooLargeError();
  }

  const created = !(await repository.exists(path));
  await repository.write(path, content);
  return { created };
}

/** Deletes a note; repository implementations provide idempotent semantics. */
export function deleteNote(
  repository: VaultRepository,
  path: NotePath,
): Promise<void> {
  return repository.delete(path);
}
