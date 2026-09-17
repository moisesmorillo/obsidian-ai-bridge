/** Closed bounded response-body read outcomes without raw remote content in failures. */
export type BoundedResponseReadResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "missing-body" }
  | {
      readonly kind: "too-large" | "aborted" | "stream-error";
      readonly settlement: Promise<void>;
    };

/**
 * Reads a response stream incrementally without trusting Content-Length.
 *
 * The reader is cancelled when a deadline wins. Early outcomes expose the
 * cancellation settlement so callers can retain request admission until the host
 * stream actually settles without delaying the bounded result. Callers decode the
 * resulting bytes with a fatal UTF-8 decoder and never include them in diagnostics.
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
  let settlement: Promise<void> | undefined;

  try {
    let done = false;
    while (!done) {
      const read = await raceWithAbort(reader.read(), signal);
      if (read.kind === "aborted" || read.kind === "stream-error") {
        settlement = cancelReader(reader);
        return { kind: read.kind, settlement };
      }
      if (read.value.done) {
        done = true;
        continue;
      }
      const chunk = read.value.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        settlement = cancelReader(reader);
        return { kind: "too-large", settlement };
      }
      chunks.push(chunk);
    }
  } finally {
    if (settlement === undefined) reader.releaseLock();
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

/**
 * Returns the first stream/deadline outcome while leaving cancellation settlement to the caller.
 *
 * @returns The first read outcome or abort marker.
 */
async function raceWithAbort<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "aborted" }
  | { readonly kind: "stream-error" }
> {
  if (signal.aborted) return { kind: "aborted" };
  return new Promise((resolve) => {
    /**
     * Resolves the bounded read as aborted without claiming the underlying stream has stopped.
     *
     * @returns No value; resolves the racing promise with an abort marker.
     */
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then(
        (value) => resolve({ kind: "value", value }),
        () => resolve({ kind: "stream-error" }),
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Settles best-effort stream cancellation before releasing its lock; callers retain admission for this promise.
 *
 * @returns Settlement after cancellation is attempted and the lock is released.
 */
function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  return reader
    .cancel()
    .catch(() => undefined)
    .finally(() => reader.releaseLock());
}
