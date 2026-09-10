import type { NOTE_BODY_RESULT_KIND } from "@worker/http/note-body.constants";

/**
 * Result of bounded, fatal UTF-8 request-body parsing.
 *
 * The success branch carries decoded text; failure branches preserve the
 * distinction between malformed encoding and an exceeded byte limit.
 */
export type NoteBodyResult =
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.ok; readonly content: string }
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.tooLarge }
  | { readonly kind: typeof NOTE_BODY_RESULT_KIND.invalidEncoding };
