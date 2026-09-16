import {
  BrowserMirrorSynchronizerRuntime,
  hasMirrorRuntimeCryptography,
  probeMirrorRuntimeCryptography,
} from "@obsidian-plugin/runtime/mirror-runtime-cryptography";
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
      "Required runtime cryptography is unavailable",
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
      "Required runtime cryptography is unavailable",
    );
  });

  it.each(["throw", "reject"])(
    "sanitizes a digest provider that will %s",
    async (failure) => {
      const subtle = new Proxy(globalThis.crypto.subtle, {
        get(target, property, receiver) {
          if (property === "digest") {
            return failure === "throw"
              ? () => {
                  throw new Error("raw provider error");
                }
              : async () => Promise.reject(new Error("raw provider error"));
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const cryptography = new Proxy(globalThis.crypto, {
        get(target, property, receiver) {
          if (property === "subtle") return subtle;
          return Reflect.get(target, property, receiver);
        },
      });
      const runtime = new BrowserMirrorSynchronizerRuntime(cryptography);
      await expect(runtime.hashContent("PRIVATE")).rejects.toThrow(
        "Required runtime cryptography is unavailable",
      );
      await expect(probeMirrorRuntimeCryptography(cryptography)).resolves.toBe(
        false,
      );
    },
  );

  it("accepts and probes a working SHA-256 provider", async () => {
    expect(hasMirrorRuntimeCryptography(globalThis.crypto)).toBe(true);
    await expect(
      probeMirrorRuntimeCryptography(globalThis.crypto),
    ).resolves.toBe(true);
  });

  it("requires both randomUUID and subtle.digest capability surfaces", async () => {
    expect(hasMirrorRuntimeCryptography(undefined)).toBe(false);
    const missingSubtle = new Proxy(globalThis.crypto, {
      get(target, property, receiver) {
        if (property === "subtle") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(hasMirrorRuntimeCryptography(missingSubtle)).toBe(false);
    await expect(probeMirrorRuntimeCryptography(missingSubtle)).resolves.toBe(
      false,
    );
    const throwingProvider = new Proxy(globalThis.crypto, {
      get() {
        throw new Error("provider getter failed");
      },
    });
    expect(hasMirrorRuntimeCryptography(throwingProvider)).toBe(false);
  });
});
