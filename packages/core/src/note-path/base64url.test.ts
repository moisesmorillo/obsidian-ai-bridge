import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@core/note-path/base64url";
import { describe, expect, it } from "vitest";

describe("base64url utilities", () => {
  it.each([
    [new Uint8Array([0, 1, 2, 253, 254, 255]), "AAEC_f7_"],
    [
      new TextEncoder().encode("Homelab/DNS/Technitium.md"),
      "SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA",
    ],
  ] as const)("encodes bytes canonically", (bytes, expected) => {
    expect(encodeBase64Url(bytes)).toBe(expected);
    expect(decodeBase64Url(expected)).toEqual(bytes);
  });

  it.each(["", "not-base64!", "A", "AA="])(
    "rejects non-canonical base64url input: %s",
    (value) => {
      expect(decodeBase64Url(value)).toBeUndefined();
    },
  );

  it("decodes valid UTF-8 and rejects malformed bytes", () => {
    expect(decodeUtf8(new TextEncoder().encode("café"))).toBe("café");
    expect(decodeUtf8(new Uint8Array([0xc3, 0x28]))).toBeUndefined();
  });
});
