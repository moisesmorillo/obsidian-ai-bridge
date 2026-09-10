const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export {
  decodeNotePath,
  encodeNotePath,
  isNormalizedNotePath,
  normalizeNotePath,
} from "./note-path";
export type { NotePath } from "./note-path";
export {
  deleteNote,
  listNotes,
  MAX_NOTE_SIZE_BYTES,
  NotePayloadTooLargeError,
  readNote,
  writeNote,
} from "./vault";
export type { VaultRepository } from "./vault";

export type Identifier = string & {
  readonly __brand: "Identifier";
};

export function createIdentifier(value: string): Identifier | undefined {
  const normalizedValue = value.trim().toLowerCase();

  if (!identifierPattern.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue as Identifier;
}
