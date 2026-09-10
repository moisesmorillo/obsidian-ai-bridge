/** Result of storing a note, including whether the write created it. */
export interface WriteNoteResult {
  /** Whether storage created the note instead of replacing an existing object. */
  readonly created: boolean;
}
