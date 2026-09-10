import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import { readNoteBody } from "@worker/http/note-body";
import { NOTE_BODY_RESULT_KIND } from "@worker/http/note-body.constants";
import { describe, expect, it } from "vitest";

function requestWithStream(chunks: readonly Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const requestInit: RequestInit & { readonly duplex: "half" } = {
    method: "PUT",
    body,
    duplex: "half",
  };
  return new Request("https://example.test/note", requestInit);
}

describe("readNoteBody", () => {
  it("returns an empty string for a missing body", async () => {
    const request = new Request("https://example.test/note", { method: "PUT" });

    await expect(readNoteBody(request)).resolves.toEqual({
      kind: NOTE_BODY_RESULT_KIND.ok,
      content: "",
    });
  });

  it("decodes valid UTF-8 content", async () => {
    const request = new Request("https://example.test/note", {
      method: "PUT",
      body: "café",
    });

    await expect(readNoteBody(request)).resolves.toEqual({
      kind: NOTE_BODY_RESULT_KIND.ok,
      content: "café",
    });
  });

  it("rejects malformed UTF-8 content", async () => {
    const request = requestWithStream([new Uint8Array([0xc3, 0x28])]);

    await expect(readNoteBody(request)).resolves.toEqual({
      kind: NOTE_BODY_RESULT_KIND.invalidEncoding,
    });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const headers = new Headers({
      "Content-Length": String(MAX_NOTE_SIZE_BYTES + 1),
    });
    const request = new Request("https://example.test/note", {
      method: "PUT",
      headers,
      body: "small",
    });

    await expect(readNoteBody(request)).resolves.toEqual({
      kind: NOTE_BODY_RESULT_KIND.tooLarge,
    });
  });

  it("rejects an oversized streamed body without trusting its declaration", async () => {
    const request = requestWithStream([
      new Uint8Array(MAX_NOTE_SIZE_BYTES),
      new Uint8Array(1),
    ]);

    await expect(readNoteBody(request)).resolves.toEqual({
      kind: NOTE_BODY_RESULT_KIND.tooLarge,
    });
  });
});
