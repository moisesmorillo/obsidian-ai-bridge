import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import { HTTP_HEADER } from "@worker/http/http.constants";
import { NOTE_BODY_RESULT_KIND } from "@worker/http/note-body.constants";
import type { NoteBodyResult } from "@worker/http/note-body.types";

/**
 * Parses a non-negative Content-Length header without treating it as authoritative.
 *
 * @param value - Raw header value, or `null` when no length was declared.
 * @returns A safe numeric hint, or `undefined` when the hint is absent or malformed.
 */
function parseDeclaredContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/**
 * Reads a stream until completion or until its byte limit is exceeded.
 *
 * @param stream - Request body stream to consume.
 * @returns Ordered chunks, or `undefined` when the configured byte limit is exceeded.
 */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[] | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    let nextChunk = await reader.read();
    while (!nextChunk.done) {
      totalBytes += nextChunk.value.byteLength;
      if (totalBytes > MAX_NOTE_SIZE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }

      chunks.push(nextChunk.value);
      nextChunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

/**
 * Joins ordered byte chunks without exposing stream implementation details.
 *
 * @param chunks - Byte chunks yielded by a request body stream.
 * @returns One contiguous byte array containing the chunks in order.
 */
function joinByteChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bodyBytes;
}

/**
 * Decodes UTF-8 strictly so invalid byte sequences do not become replacement characters.
 *
 * @param bytes - Body bytes expected to contain UTF-8 text.
 * @returns Decoded text, or `undefined` when the sequence is malformed.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Reads and validates a raw note request body without trusting Content-Length.
 *
 * @param request - Fetch request whose body may contain raw Markdown or plain text.
 * @returns Valid text or a typed body failure preserving M1 payload semantics.
 */
export async function readNoteBody(request: Request): Promise<NoteBodyResult> {
  const declaredLength = parseDeclaredContentLength(
    request.headers.get(HTTP_HEADER.contentLength),
  );
  if (declaredLength !== undefined && declaredLength > MAX_NOTE_SIZE_BYTES) {
    return { kind: NOTE_BODY_RESULT_KIND.tooLarge };
  }
  if (request.body === null) {
    return { kind: NOTE_BODY_RESULT_KIND.ok, content: "" };
  }

  const chunks = await readBoundedStream(request.body);
  if (chunks === undefined) {
    return { kind: NOTE_BODY_RESULT_KIND.tooLarge };
  }

  const content = decodeUtf8(joinByteChunks(chunks));
  return content === undefined
    ? { kind: NOTE_BODY_RESULT_KIND.invalidEncoding }
    : { kind: NOTE_BODY_RESULT_KIND.ok, content };
}
