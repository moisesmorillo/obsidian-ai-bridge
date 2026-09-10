/**
 * Extracts a normalized media type from an HTTP Content-Type header.
 *
 * @param contentType - Raw Content-Type header value.
 * @returns Lowercase media type, or `undefined` when the header is absent or empty.
 */
export function parseMediaType(
  contentType: string | null | undefined,
): string | undefined {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "" ? undefined : mediaType;
}
