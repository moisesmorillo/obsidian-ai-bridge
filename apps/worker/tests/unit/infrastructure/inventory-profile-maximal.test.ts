import { encodeNotePath } from "@obsidian-ai-bridge/core";
import { syncHeadKey } from "@protocol/sync.codec";
import {
  decodeSyncRecord,
  encodeSyncRecord,
} from "@worker/infrastructure/sync/sync-record.codec";
import { PROFILE_IDS } from "@worker-tests/runtime/fixtures/inventory-profile.contract";
import { profileHead } from "@worker-tests/runtime/fixtures/inventory-profile.worker";
import { expect, it } from "vitest";

it.each([0, 9999])(
  "encodes a legal full-ceiling head and retains its exact path at index %i",
  async (index) => {
    const head = profileHead(index, "maximum_encoded");
    const bytes = await encodeSyncRecord({ kind: "head", record: head });
    const key = syncHeadKey(PROFILE_IDS.vaultId, head.path);
    expect(bytes.byteLength).toBe(2048);
    expect(new TextEncoder().encode(head.path).byteLength).toBe(720);
    expect(head.kind).toBe(index === 0 ? "live" : "tombstone");
    expect(head.byteSize).toBe(1048576);
    expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(1024);
    const decoded = await decodeSyncRecord(
      "head",
      key,
      bytes,
      PROFILE_IDS.vaultId,
    );
    expect(decoded).toEqual({ kind: "head", record: head });
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          pathKey: encodeNotePath(head.path),
          revision: head.revision,
          kind: head.kind,
        }),
      ).byteLength,
    ).toBe(index === 0 ? 1038 : 1043);
  },
);

it("preserves the original baseline's deterministic 1184-byte live head", async () => {
  const head = profileHead(0);
  expect(
    (await encodeSyncRecord({ kind: "head", record: head })).byteLength,
  ).toBe(1184);
  expect(head.kind).toBe("live");
  expect(head.path.split("/").at(-1)).toBe(`000000${"n".repeat(27)}.md`);
});
