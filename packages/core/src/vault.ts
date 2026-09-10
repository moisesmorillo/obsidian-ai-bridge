import type { NotePath } from "./note-path";

export const MAX_NOTE_SIZE_BYTES = 1024 * 1024;

export interface VaultRepository {
  list(): Promise<readonly NotePath[]>;
  exists(path: NotePath): Promise<boolean>;
  read(path: NotePath): Promise<string | null>;
  write(path: NotePath, content: string): Promise<void>;
  delete(path: NotePath): Promise<void>;
}

export class NotePayloadTooLargeError extends Error {
  constructor() {
    super("The note payload exceeds the maximum supported size.");
    this.name = "NotePayloadTooLargeError";
  }
}

export async function listNotes(
  repository: VaultRepository,
): Promise<NotePath[]> {
  return [...(await repository.list())].sort();
}

export function readNote(
  repository: VaultRepository,
  path: NotePath,
): Promise<string | null> {
  return repository.read(path);
}

export async function writeNote(
  repository: VaultRepository,
  path: NotePath,
  content: string,
): Promise<{ readonly created: boolean }> {
  const contentSize = new TextEncoder().encode(content).byteLength;
  if (contentSize > MAX_NOTE_SIZE_BYTES) {
    throw new NotePayloadTooLargeError();
  }

  const created = !(await repository.exists(path));
  await repository.write(path, content);
  return { created };
}

export function deleteNote(
  repository: VaultRepository,
  path: NotePath,
): Promise<void> {
  return repository.delete(path);
}
