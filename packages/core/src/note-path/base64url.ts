import {
  BASE64_CHUNK_SIZE,
  BASE64URL_PATTERN,
} from "@core/note-path/note-path.constants";

/**
 * Encodes bytes as an unpadded base64url string.
 *
 * @param bytes - Bytes to encode.
 * @returns The URL-safe base64 representation without padding.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a base64url value into bytes.
 *
 * @param value - Candidate unpadded base64url value.
 * @returns Decoded bytes, or `undefined` when the alphabet or length is invalid.
 */
export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return undefined;
  }

  const base64Value = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddedValue = base64Value.padEnd(
    base64Value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );

  try {
    return Uint8Array.from(atob(paddedValue), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

/**
 * Decodes bytes as strict UTF-8.
 *
 * @param bytes - Bytes expected to contain valid UTF-8.
 * @returns Decoded text, or `undefined` when the byte sequence is malformed.
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
