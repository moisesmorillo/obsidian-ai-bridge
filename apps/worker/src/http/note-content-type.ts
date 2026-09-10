import {
  MARKDOWN_MEDIA_TYPE,
  PLAIN_TEXT_MEDIA_TYPE,
} from "@worker/http/http.constants";

/** Checks whether a request declares one of the raw-text note media types. */
export function isSupportedNoteContentType(
  contentType: string | null | undefined,
): boolean {
  if (contentType === null || contentType === undefined) {
    return true;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === MARKDOWN_MEDIA_TYPE || mediaType === PLAIN_TEXT_MEDIA_TYPE
  );
}
