import { isUuidV4 } from "@obsidian-ai-bridge/core";
import {
  generateApplicationRevision,
  sha256Content,
} from "@worker/storage/storage-crypto";
import { describe, expect, it } from "vitest";

describe("Worker storage cryptography", () => {
  it.each([
    [
      "ASCII",
      "abc",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
    [
      "multibyte UTF-8",
      "Résumé 📝",
      "567c5d518dc5e01a097970385933830ffd542e8a5eccbc615b2d138dd42c9769",
    ],
    [
      "empty text",
      "",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ],
  ])(
    "hashes exact %s note bytes to canonical lowercase hex",
    async (_name, content, expected) => {
      await expect(sha256Content(content)).resolves.toBe(expected);
      await expect(sha256Content(content)).resolves.toBe(expected);
    },
  );

  it("generates distinct canonical UUID-v4 application revisions", () => {
    const first = generateApplicationRevision();
    const second = generateApplicationRevision();

    expect(isUuidV4(first)).toBe(true);
    expect(isUuidV4(second)).toBe(true);
    expect(second).not.toBe(first);
  });
});
