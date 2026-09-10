import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@core/note-path/base64url";
import type { NotePath } from "@core/note-path/note-path.types";
import {
  containsDangerousEncoding,
  isSafeDecodedPath,
} from "@core/note-path/note-path-validation";

/**
 * Brands a string after the caller has established the note-path invariant.
 *
 * @param value - Path already checked by note-path validation.
 * @returns The branded path used by core repository ports.
 */
function createNotePath(value: string): NotePath {
  return value as NotePath;
}

/**
 * Normalizes a relative Markdown path while rejecting traversal and encoded bypasses.
 *
 * @param value - Request or storage path candidate.
 * @returns A canonical validated path, or `undefined` when the candidate is unsafe.
 */
export function normalizeNotePath(value: string): NotePath | undefined {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")) {
    return undefined;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value);
  } catch {
    return undefined;
  }

  if (
    decodedPath.length === 0 ||
    containsDangerousEncoding(value) ||
    containsDangerousEncoding(decodedPath) ||
    !isSafeDecodedPath(decodedPath)
  ) {
    return undefined;
  }

  return createNotePath(decodedPath);
}

/**
 * Narrows a string that is already a normalized vault path.
 *
 * @param value - Candidate path from a trusted repository boundary.
 * @returns Whether the value satisfies the normalized note-path invariant.
 */
export function isNormalizedNotePath(value: string): value is NotePath {
  return !containsDangerousEncoding(value) && isSafeDecodedPath(value);
}

/**
 * Encodes a normalized note path as its canonical unpadded base64url identifier.
 *
 * @param path - Normalized Markdown path.
 * @returns The URL-safe identifier used by note item routes.
 */
export function encodeNotePath(path: NotePath): string {
  return encodeBase64Url(new TextEncoder().encode(path));
}

/**
 * Decodes only canonical base64url identifiers that represent a safe note path.
 *
 * @param value - URL route identifier to validate and decode.
 * @returns The normalized note path, or `undefined` for malformed or non-canonical input.
 */
export function decodeNotePath(value: string): NotePath | undefined {
  const bytes = decodeBase64Url(value);
  if (bytes === undefined) {
    return undefined;
  }

  const decodedPath = decodeUtf8(bytes);
  if (decodedPath === undefined || !isNormalizedNotePath(decodedPath)) {
    return undefined;
  }

  return encodeNotePath(decodedPath) === value
    ? createNotePath(decodedPath)
    : undefined;
}
