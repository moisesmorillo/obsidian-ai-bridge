/** Maximum decoding passes used to detect encoded traversal bypasses. */
export const MAX_DANGEROUS_ENCODING_PASSES = 4;

/** Encoded path characters that can introduce traversal or null-byte bypasses. */
export const DANGEROUS_ENCODED_CHARACTER_PATTERN = /%(?:2e|2f|5c|00)/i;

/** Alphabet accepted by the canonical unpadded base64url decoder. */
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Required file extension for normalized vault note paths. */
export const MARKDOWN_FILE_EXTENSION = ".md";

/** Chunk size that keeps binary conversion arguments within runtime limits. */
export const BASE64_CHUNK_SIZE = 0x8000;
