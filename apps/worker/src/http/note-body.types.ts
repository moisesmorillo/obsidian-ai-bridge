/** Result of bounded, fatal UTF-8 request-body parsing. */
export type NoteBodyResult =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "too_large" }
  | { readonly kind: "invalid_encoding" };
