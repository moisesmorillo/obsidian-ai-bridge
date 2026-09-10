import {
  DANGEROUS_ENCODED_CHARACTER_PATTERN,
  MARKDOWN_FILE_EXTENSION,
  MAX_DANGEROUS_ENCODING_PASSES,
} from "@core/note-path/note-path.constants";

/**
 * Checks decoded path syntax and platform-sensitive path forms.
 *
 * @param value - Decoded candidate path.
 * @returns Whether the path is a relative Markdown path without dot segments.
 */
export function isSafeDecodedPath(value: string): boolean {
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

/**
 * Finds traversal-relevant encodings across a bounded number of decode passes.
 *
 * @param value - Raw or partially decoded path candidate.
 * @returns Whether the candidate contains an encoded separator, null byte, or dot segment.
 *
 * A bounded pass count prevents attacker-controlled decoding work from becoming unbounded.
 */
export function containsDangerousEncoding(value: string): boolean {
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
