/** Content type of JSON read bodies and read failures. */
const JSON_CONTENT_TYPE = "application/json; charset=UTF-8";

/**
 * Build the headers of a JSON read or read failure response.
 * `Cache-Control: no-transform` stops edge compression of lazily produced bodies, so a body that the
 * Worker errors at its lease deadline reaches the client as a transport failure, not as a short
 * compressed 200. Existing headers such as Retry-After are kept; a caller Content-Type wins.
 * @param headers - Route or failure headers to keep, such as ETag or Retry-After.
 */
export function jsonReadHeaders(headers?: HeadersInit): Headers {
	const result = new Headers(headers);
	if (!result.has("Content-Type"))
		result.set("Content-Type", JSON_CONTENT_TYPE);
	result.set("Cache-Control", "no-transform");
	return result;
}
