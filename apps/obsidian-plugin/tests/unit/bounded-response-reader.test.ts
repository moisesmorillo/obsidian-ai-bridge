import {
  decodeStrictUtf8,
  readBoundedResponseBytes,
} from "@obsidian-plugin/remote/bounded-response-reader";
import { describe, expect, it } from "vitest";

describe("bounded response reader", () => {
  it("accepts exactly the byte bound and rejects one byte over", async () => {
    const controller = new AbortController();
    await expect(
      readBoundedResponseBytes(new Response("1234"), 4, controller.signal),
    ).resolves.toMatchObject({
      kind: "ok",
      bytes: new Uint8Array([49, 50, 51, 52]),
    });
    await expect(
      readBoundedResponseBytes(new Response("12345"), 4, controller.signal),
    ).resolves.toEqual({ kind: "too-large" });
  });

  it("counts chunked bytes and handles required missing bodies", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12"));
        controller.enqueue(new TextEncoder().encode("345"));
        controller.close();
      },
    });
    const controller = new AbortController();
    await expect(
      readBoundedResponseBytes(new Response(stream), 4, controller.signal),
    ).resolves.toEqual({ kind: "too-large" });
    await expect(
      readBoundedResponseBytes(new Response(null), 1, controller.signal),
    ).resolves.toEqual({ kind: "missing-body" });
  });

  it("cancels a stream error without leaking its rejection", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("intermediary failure"));
      },
    });
    await expect(
      readBoundedResponseBytes(
        new Response(stream),
        10,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "aborted" });
  });

  it("strictly rejects malformed UTF-8 and returns a deadline abort without waiting for a reader", async () => {
    expect(decodeStrictUtf8(new Uint8Array([0xc3, 0x28]))).toBeUndefined();
    expect(decodeStrictUtf8(new TextEncoder().encode("雪"))).toBe("雪");

    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const pending = readBoundedResponseBytes(
      new Response(stream),
      10,
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "aborted" });
  });
});
