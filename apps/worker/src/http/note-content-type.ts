import { SUPPORTED_NOTE_MEDIA_TYPES } from "@worker/http/http.constants";
import { parseMediaType } from "@worker/http/media-type";

/**
 * Checks whether a request declares one of the raw-text note media types.
 *
 * @param contentType - Raw Content-Type header value.
 * @returns Whether the request is compatible with the note body contract.
 */
export function isSupportedNoteContentType(
  contentType: string | null | undefined,
): boolean {
  const mediaType = parseMediaType(contentType);
  if (mediaType === undefined) {
    return true;
  }

  return SUPPORTED_NOTE_MEDIA_TYPES.some(
    (supportedMediaType) => supportedMediaType === mediaType,
  );
}
