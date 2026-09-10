/** Result of bounded, fatal UTF-8 request-body parsing. */
export const NOTE_BODY_RESULT_KIND = {
  invalidEncoding: "invalid_encoding",
  ok: "ok",
  tooLarge: "too_large",
} as const;

/** Result of bounded, fatal UTF-8 request-body parsing. */
export type NoteBodyResult =
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.ok; readonly content: string }
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.tooLarge }
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.invalidEncoding };
