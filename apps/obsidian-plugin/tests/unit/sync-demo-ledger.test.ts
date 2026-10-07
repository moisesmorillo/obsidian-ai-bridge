import {
  encodeSyncCursor,
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { SyncDemoLedgerRepository } from "@obsidian-plugin/demo/sync-demo-ledger";
import { describe, expect, it } from "vitest";

const binding = {
  vaultId: syncVaultIdSchema.parse("22222222-2222-4222-8222-222222222222"),
  deviceId: syncDeviceIdSchema.parse("33333333-3333-4333-8333-333333333333"),
  paths: [syncNotePathSchema.parse("demo.md")],
};
const cursor = encodeSyncCursor({
  protocolMajor: 1,
  vaultId: binding.vaultId,
  laneSequences: Array.from({ length: 64 }, () =>
    syncSequenceSchema.parse("00000000000000000000"),
  ),
  nextLane: 0,
});
const fresh = {
  schemaVersion: 1 as const,
  vaultId: binding.vaultId,
  deviceId: binding.deviceId,
  cursor,
  entries: [
    { path: syncNotePathSchema.parse("demo.md"), base: null, work: null },
  ],
};
function fixture(initial: string | null = null) {
  let bytes = initial;
  const storage = {
    read: async () => bytes,
    write: async (value: string) => {
      bytes = value;
    },
  };
  return {
    storage,
    repository: new SyncDemoLedgerRepository(storage, binding),
    read: () => bytes,
  };
}

describe("read-back verified M8 ledger persistence", () => {
  it("bounds persisted input before parsing even a schema-valid whitespace-inflated ledger", async () => {
    const serialized = " ".repeat(20_000) + JSON.stringify(fresh);
    const f = fixture(serialized);
    expect(await f.repository.load()).toEqual({ kind: "blocked" });
    expect(f.read()).toBe(serialized);
  });
  it("fits three maximum-length paths with full original requests inside the content-free state budget", async () => {
    const { syncDemoLedgerSchema } = await import(
      "@obsidian-ai-bridge/protocol"
    );
    const paths = ["a", "b", "c"].map((letter) =>
      syncNotePathSchema.parse(
        `${letter.repeat(235)}/${letter.repeat(235)}/${letter.repeat(245)}.md`,
      ),
    );
    const ledger = syncDemoLedgerSchema.parse({
      ...fresh,
      entries: paths.map((path, index) => {
        const revision = `${(index + 1).toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
        return {
          path,
          base: { revision, contentSha256: "a".repeat(64) },
          work: {
            kind: "push",
            certainty: "uncertain",
            operationId: `${(index + 101).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
            revision: `${(index + 201).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
            parent: { kind: "revision", revision },
            contentSha256: "b".repeat(64),
            retryAfterEpochMs: Number.MAX_SAFE_INTEGER,
          },
        };
      }),
    });
    const f = fixture();
    const repository = new SyncDemoLedgerRepository(f.storage, {
      ...binding,
      paths,
    });
    expect(await repository.save(ledger)).toBe(true);
    expect(await repository.load()).toEqual({ kind: "ready", ledger });
    expect(
      new TextEncoder().encode(JSON.stringify(ledger)).byteLength,
    ).toBeLessThanOrEqual(16384);
  });
  it("durably initializes an absent ledger at zero and rehydrates it in a new owner", async () => {
    const f = fixture();
    expect(await f.repository.load()).toEqual({ kind: "ready", ledger: fresh });
    expect(
      await new SyncDemoLedgerRepository(f.storage, binding).load(),
    ).toEqual({ kind: "ready", ledger: fresh });
    expect(f.read()).toBe(JSON.stringify(fresh));
  });
  it.each([
    "not-json",
    "null",
    JSON.stringify({ ...fresh, schemaVersion: 2 }),
    JSON.stringify({ ...fresh, deviceId: binding.vaultId }),
    JSON.stringify({ ...fresh, entries: [] }),
  ])(
    "does not reset corrupt, unsupported or mismatched state %s",
    async (initial) => {
      const f = fixture(initial);
      expect(await f.repository.load()).toEqual({ kind: "blocked" });
      expect(f.read()).toBe(initial);
    },
  );
  it("rejects a foreign-binding save before storage and permanently fences that owner", async () => {
    const f = fixture(JSON.stringify(fresh));
    expect(
      await f.repository.save({
        ...fresh,
        deviceId: syncDeviceIdSchema.parse(
          "66666666-6666-4666-8666-666666666666",
        ),
      }),
    ).toBe(false);
    expect(f.read()).toBe(JSON.stringify(fresh));
    expect(await f.repository.load()).toEqual({ kind: "blocked" });
    expect(await f.repository.save(fresh)).toBe(false);
  });
  it("refuses lost writes and unavailable read-back instead of publishing an in-memory ACK", async () => {
    const f = fixture(JSON.stringify(fresh));
    const repository = new SyncDemoLedgerRepository(
      { read: f.storage.read, write: async () => {} },
      binding,
    );
    const next = {
      ...fresh,
      cursor: encodeSyncCursor({
        protocolMajor: 1,
        vaultId: binding.vaultId,
        laneSequences: Array.from({ length: 64 }, () =>
          syncSequenceSchema.parse("00000000000000000000"),
        ),
        nextLane: 1,
      }),
    };
    expect(await repository.save(next)).toBe(false);
    expect(await repository.load()).toEqual({ kind: "blocked" });
  });
  it("fences its owner on unavailable storage", async () => {
    const f = new SyncDemoLedgerRepository(
      {
        read: async () => {
          throw new Error("private host failure");
        },
        write: async () => {},
      },
      binding,
    );
    expect(await f.load()).toEqual({ kind: "blocked" });
    expect(await f.save(fresh)).toBe(false);
  });
});
