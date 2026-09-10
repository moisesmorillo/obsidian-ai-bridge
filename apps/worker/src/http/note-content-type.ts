import {
  MARKDOWN_MEDIA_TYPE,
  PLAIN_TEXT_MEDIA_TYPE,
} from "@worker/http/http.constants";
import { parseMediaType } from "@worker/http/media-type";

/** Checks whether a request declares one of the raw-text note media types. */
export function isSupportedNoteContentType(
  contentType: string | null | undefined,
): boolean {
  const mediaType = parseMediaType(contentType);
  if (mediaType === undefined) {
    return true;
  }

  return (
    mediaType === MARKDOWN_MEDIA_TYPE || mediaType === PLAIN_TEXT_MEDIA_TYPE
  );
}
