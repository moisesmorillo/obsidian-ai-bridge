import {
  createApplicationEtag,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  formatApplicationEtag,
  isApplicationEtag,
  parseApplicationEtag,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

const UUID_V4 = "8f4c6a20-2b51-4d86-9c55-df50d9390d96";
const SHA_256 = "a3".repeat(32);

describe("M3 mirror identifiers", () => {
  it("creates validated opaque identities and application validators", () => {
    expect(createMirrorAssociationId(UUID_V4)).toBe(UUID_V4);
    expect(createMirrorWriterId(UUID_V4)).toBe(UUID_V4);
    expect(createMirrorOperationId(UUID_V4)).toBe(UUID_V4);
    expect(createApplicationRevision(UUID_V4)).toBe(UUID_V4);
    expect(createRecoverySnapshotId(UUID_V4)).toBe(UUID_V4);
    expect(createContentSha256(SHA_256)).toBe(SHA_256);
    const revision = createApplicationRevision(UUID_V4);
    if (revision === undefined) throw new Error("Invalid revision fixture");
    const etag = formatApplicationEtag(revision);
    expect(etag).toBe(`"m3-${UUID_V4}"`);
    expect(createApplicationEtag(etag)).toBe(etag);
    expect(isApplicationEtag(etag)).toBe(true);
    expect(isApplicationEtag("not-an-etag")).toBe(false);
    expect(parseApplicationEtag(etag)).toBe(revision);
  });

  it("rejects malformed, non-v4, and noncanonical values", () => {
    expect(createMirrorAssociationId("not-a-uuid")).toBeUndefined();
    expect(
      createMirrorWriterId("8f4c6a20-2b51-1d86-9c55-df50d9390d96"),
    ).toBeUndefined();
    expect(
      createMirrorOperationId("8F4C6A20-2B51-4D86-9C55-DF50D9390D96"),
    ).toBeUndefined();
    expect(
      createApplicationRevision("8f4c6a20-2b51-4d86-7c55-df50d9390d96"),
    ).toBeUndefined();
    expect(
      createRecoverySnapshotId("8f4c6a20-2b51-4d86-9c55-df50d9390d96 "),
    ).toBeUndefined();
    expect(createContentSha256(SHA_256.toUpperCase())).toBeUndefined();
    expect(createContentSha256("a3".repeat(31))).toBeUndefined();
    for (const value of [
      `W/"m3-${UUID_V4}"`,
      "*",
      `"m3-${UUID_V4}", "m3-${UUID_V4}"`,
      '"m3-not-a-revision"',
      `"other-${UUID_V4}"`,
    ]) {
      expect(createApplicationEtag(value)).toBeUndefined();
      expect(parseApplicationEtag(value)).toBeUndefined();
    }
  });
});
