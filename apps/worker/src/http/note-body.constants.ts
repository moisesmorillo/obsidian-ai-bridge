/** Closed result kinds returned by bounded note-body parsing. */
export const NOTE_BODY_RESULT_KIND = {
  invalidEncoding: "invalid_encoding",
  ok: "ok",
  tooLarge: "too_large",
} as const;
