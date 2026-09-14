import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  type HandoffPayload,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  createHandoffRecord,
  decodeHandoffRecord,
  encodeHandoffRecord,
  HANDOFF_RECORD_FORMAT,
  MAX_HANDOFF_RECORD_BYTES,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const LIVE_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const RECOVERY_ID = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const LIVE_PATH = required(normalizeNotePath("notes/live.md"));
const DELETED_PATH = required(normalizeNotePath("notes/deleted.md"));
const integrity = new WebCryptoHandoffIntegrity();

function payload(): HandoffPayload {
  return {
    associationId: ASSOCIATION_ID,
    origin: "https://bridge.example",
    entries: [
      {
        path: LIVE_PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: LIVE_REVISION,
          contentSha256: HASH,
        },
      },
      {
        path: DELETED_PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision: TOMBSTONE_REVISION,
          recoveryId: RECOVERY_ID,
        },
      },
    ],
  };
}

describe("content-free handoff codec", () => {
  it("round-trips canonical ACK metadata with an integrity checksum", async () => {
    const record = await createHandoffRecord(payload(), integrity);
    const encoded = encodeHandoffRecord(record);
    expect(await decodeHandoffRecord(encoded, integrity)).toEqual({
      kind: "valid",
      record,
    });
    expect(encoded).not.toMatch(
      /token|bearer|secret|deviceId|activation|body|content"/i,
    );
    expect(encoded).not.toContain("PRIVATE NOTE BODY");
  });

  it("rejects malformed/future, duplicate, invalid, and authority-bearing records", async () => {
    expect(await decodeHandoffRecord("{", integrity)).toEqual({
      kind: "corrupt",
    });
    expect(
      await decodeHandoffRecord(
        "x".repeat(MAX_HANDOFF_RECORD_BYTES + 1),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      await decodeHandoffRecord(
        JSON.stringify({ format: HANDOFF_RECORD_FORMAT, version: 2 }),
        integrity,
      ),
    ).toEqual({ kind: "unsupported-version", version: 2 });

    const record = await createHandoffRecord(payload(), integrity);
    const raw = {
      format: HANDOFF_RECORD_FORMAT,
      version: 1,
      origin: record.origin,
      associationId: record.associationId,
      entries: record.entries,
      checksum: record.checksum,
    };
    expect(
      await decodeHandoffRecord(
        JSON.stringify({
          ...raw,
          entries: [record.entries[0], record.entries[0]],
        }),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      await decodeHandoffRecord(
        JSON.stringify({ ...raw, associationId: "invalid" }),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      await decodeHandoffRecord(
        JSON.stringify({ ...raw, origin: "https://BRIDGE.example" }),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      await decodeHandoffRecord(
        JSON.stringify({
          ...raw,
          activation: true,
          deviceId: "copied",
          token: "PRIVATE",
        }),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("projects transferable entries without structurally assignable private fields", async () => {
    const current = payload();
    const entry = current.entries[0] ?? neverValue();
    const acknowledgementWithPrivate = {
      ...entry.acknowledgement,
      token: "PRIVATE_ACK_TOKEN",
    };
    const entryWithPrivate = {
      ...entry,
      body: "PRIVATE_NOTE_BODY",
      acknowledgement: acknowledgementWithPrivate,
    };
    const payloadWithPrivate = {
      ...current,
      activation: true,
      deviceId: "PRIVATE_DEVICE",
      entries: [entryWithPrivate],
    };
    const record = await createHandoffRecord(payloadWithPrivate, integrity);
    const recordWithPrivate = { ...record, secret: "PRIVATE_SECRET" };
    const encoded = encodeHandoffRecord(recordWithPrivate);
    expect(encoded).not.toMatch(
      /PRIVATE_|token|body|secret|deviceId|activation/,
    );
    expect(await decodeHandoffRecord(encoded, integrity)).toEqual({
      kind: "valid",
      record,
    });
  });

  it("refuses duplicate export payload paths before producing a checksum", async () => {
    const duplicate: HandoffPayload = {
      ...payload(),
      entries: [
        payload().entries[0] ?? neverValue(),
        payload().entries[0] ?? neverValue(),
      ],
    };
    await expect(createHandoffRecord(duplicate, integrity)).rejects.toThrow(
      "Duplicate",
    );
  });

  it("detects changed transferred metadata instead of trusting a stale checksum", async () => {
    const record = await createHandoffRecord(payload(), integrity);
    const changedPayload: HandoffPayload = {
      ...payload(),
      entries: payload().entries.map((entry) =>
        entry.path === LIVE_PATH
          ? {
              ...entry,
              acknowledgement: {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
                revision: LIVE_REVISION,
                contentSha256: required(createContentSha256("cd".repeat(32))),
              },
            }
          : entry,
      ),
    };
    const changedRaw = {
      format: HANDOFF_RECORD_FORMAT,
      version: 1,
      origin: changedPayload.origin,
      associationId: changedPayload.associationId,
      entries: changedPayload.entries,
      checksum: record.checksum,
    };
    expect(
      await decodeHandoffRecord(JSON.stringify(changedRaw), integrity),
    ).toEqual({
      kind: "integrity-mismatch",
    });
  });
});

function neverValue(): never {
  throw new Error("Unreachable fixture branch.");
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
