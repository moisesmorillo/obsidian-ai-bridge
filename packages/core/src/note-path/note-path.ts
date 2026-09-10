import {
  BASE64_CHUNK_SIZE,
  BASE64URL_PATTERN,
  DANGEROUS_ENCODED_CHARACTER_PATTERN,
  MARKDOWN_FILE_EXTENSION,
  MAX_DANGEROUS_ENCODING_PASSES,
} from "@core/note-path/note-path.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Validates decoded path segments and platform-sensitive path forms. */
function isSafeDecodedPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    !value.endsWith(MARKDOWN_FILE_EXTENSION)
  ) {
    return false;
  }

  return !value
    .split("/")
    .some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    );
}

/** Detects encoded traversal forms across a bounded number of decode passes. */
function containsDangerousEncoding(value: string): boolean {
  let candidate = value;

  for (let pass = 0; pass < MAX_DANGEROUS_ENCODING_PASSES; pass += 1) {
    if (
      DANGEROUS_ENCODED_CHARACTER_PATTERN.test(candidate) ||
      candidate
        .split(/[\\/]/)
        .some((segment) => segment === "." || segment === "..")
    ) {
      return true;
    }

    let nextValue: string;
    try {
      nextValue = decodeURIComponent(candidate);
    } catch {
      return false;
    }

    if (nextValue === candidate) {
      return false;
    }

    candidate = nextValue;
  }

  return true;
}

/** Brands a string after the caller has established the note-path invariant. */
function createNotePath(value: string): NotePath {
  return value as NotePath;
}

/** Normalizes a relative Markdown path while rejecting traversal and encoded bypasses. */
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

/** Narrows a string that is already a normalized vault path. */
export function isNormalizedNotePath(value: string): value is NotePath {
  return !containsDangerousEncoding(value) && isSafeDecodedPath(value);
}

/** Converts bytes to an ASCII-compatible string accepted by `btoa`. */
function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }

  return binary;
}

/** Converts an `atob` result into bytes before fatal UTF-8 decoding. */
function binaryToBytes(binary: string): Uint8Array {
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encodes a normalized note path as its canonical unpadded base64url identifier. */
export function encodeNotePath(path: NotePath): string {
  return btoa(bytesToBinary(new TextEncoder().encode(path)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decodes only canonical base64url identifiers that represent a safe note path. */
export function decodeNotePath(value: string): NotePath | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return undefined;
  }

  const base64Value = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddedValue = base64Value.padEnd(
    base64Value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );

  let decodedPath: string;
  try {
    decodedPath = new TextDecoder("utf-8", { fatal: true }).decode(
      binaryToBytes(atob(paddedValue)),
    );
  } catch {
    return undefined;
  }

  if (!isNormalizedNotePath(decodedPath)) {
    return undefined;
  }

  return encodeNotePath(decodedPath) === value
    ? createNotePath(decodedPath)
    : undefined;
}
