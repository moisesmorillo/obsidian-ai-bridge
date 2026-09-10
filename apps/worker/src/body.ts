import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";

export type NoteBodyResult =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "too_large" }
  | { readonly kind: "invalid_encoding" };

export async function readNoteBody(request: Request): Promise<NoteBodyResult> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      Number.isSafeInteger(declaredLength) &&
      declaredLength > MAX_NOTE_SIZE_BYTES
    ) {
      return { kind: "too_large" };
    }
  }

  if (request.body === null) {
    return { kind: "ok", content: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_NOTE_SIZE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      kind: "ok",
      content: new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
    };
  } catch {
    return { kind: "invalid_encoding" };
  }
}
