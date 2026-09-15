/** Closed bounded response-body read outcomes without raw remote content in failures. */
export type BoundedResponseReadResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "missing-body" }
  | { readonly kind: "too-large" }
  | { readonly kind: "aborted" };

/**
 * Reads a response stream incrementally without trusting Content-Length.
 *
 * The reader is cancelled when a deadline wins so a non-cooperative stream cannot
 * retain adapter ownership indefinitely. Callers decode the resulting bytes with a
 * fatal UTF-8 decoder and never include the bytes in diagnostics.
 *
 * @param response - Standards Response with an optional byte stream.
 * @param maximumBytes - Inclusive actual-byte limit for the body.
 * @param signal - Operation signal that covers headers and body consumption.
 * @returns Bounded bytes or a sanitized stream outcome.
 */
export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<BoundedResponseReadResult> {
  if (response.body === null) return { kind: "missing-body" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    let done = false;
    while (!done) {
      const read = await raceWithAbort(reader.read(), signal);
      if (read.kind === "aborted") {
        cancelReader(reader);
        return read;
      }
      if (read.value.done) {
        done = true;
        continue;
      }
      const chunk = read.value.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        cancelReader(reader);
        return { kind: "too-large" };
      }
      chunks.push(chunk);
    }
  } catch {
    cancelReader(reader);
    return signal.aborted ? { kind: "aborted" } : { kind: "missing-body" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

/**
 * Strictly decodes protocol bytes without accepting replacement characters.
 *
 * @returns Decoded text, or `undefined` for malformed UTF-8.
 */
export function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function raceWithAbort<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "aborted" }
> {
  if (signal.aborted) return { kind: "aborted" };
  return new Promise((resolve) => {
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then(
        (value) => resolve({ kind: "value", value }),
        () => resolve({ kind: "aborted" }),
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}
