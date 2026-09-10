export type { Identifier } from "@core/identifier";
export { createIdentifier } from "@core/identifier";
export {
  decodeNotePath,
  encodeNotePath,
  isNormalizedNotePath,
  normalizeNotePath,
} from "@core/note-path/note-path";
export type { NotePath } from "@core/note-path/note-path.types";
export {
  deleteNote,
  listNotes,
  readNote,
  writeNote,
} from "@core/vault/note-service";
export { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";
export {
  NotePayloadTooLargeError,
  StoredNoteTooLargeError,
} from "@core/vault/vault.errors";
export type { WriteNoteResult } from "@core/vault/vault.types";
export type { VaultRepository } from "@core/vault/vault-repository.port";
