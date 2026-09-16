import { BrowserMirrorSynchronizerRuntime } from "@obsidian-plugin/runtime/mirror-runtime-cryptography";
import { describe, expect, it } from "vitest";

describe("BrowserMirrorSynchronizerRuntime", () => {
  it("rejects an invalid SHA-256 digest from the cryptography provider", async () => {
    const subtle = new Proxy(globalThis.crypto.subtle, {
      get(target, property, receiver) {
        if (property === "digest") {
          return async () => new Uint8Array(31).buffer;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const invalid = new Proxy(globalThis.crypto, {
      get(target, property, receiver) {
        if (property === "subtle") return subtle;
        return Reflect.get(target, property, receiver);
      },
    });
    const runtime = new BrowserMirrorSynchronizerRuntime(invalid);
    await expect(runtime.hashContent("content")).rejects.toThrow(
      "Invalid SHA-256 provider output",
    );
  });

  it("rejects an invalid operation identity from the cryptography provider", () => {
    const invalid = new Proxy(globalThis.crypto, {
      get(target, property, receiver) {
        if (property === "randomUUID") return () => "invalid";
        return Reflect.get(target, property, receiver);
      },
    });
    const runtime = new BrowserMirrorSynchronizerRuntime(invalid);
    expect(() => runtime.createOperationId()).toThrow(
      "Invalid random UUID provider output",
    );
  });
});
