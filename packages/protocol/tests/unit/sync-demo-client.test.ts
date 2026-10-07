import * as protocol from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const vaultId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const revision = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const hash = "a".repeat(64);
const cursor = protocol.encodeSyncCursor({
  protocolMajor: 1,
  vaultId: protocol.syncVaultIdSchema.parse(vaultId),
  laneSequences: Array.from({ length: 64 }, () =>
    protocol.syncSequenceSchema.parse("00000000000000000000"),
  ),
  nextLane: 0,
});
const state = {
  schemaVersion: 1,
  vaultId,
  deviceId,
  cursor,
  entries: [{ path: "demo.md", base: null, work: null }],
};

describe("content-free M8 client ledger", () => {
  it.each(["uncertain", "not_admitted"] as const)(
    "rehydrates exact request identity and retry floor without plaintext (%s)",
    (certainty) => {
      const value = {
        ...state,
        entries: [
          {
            path: "demo.md",
            base: { revision, contentSha256: hash },
            work: {
              kind: "push",
              certainty,
              operationId,
              revision: "66666666-6666-4666-8666-666666666666",
              parent: { kind: "revision", revision },
              contentSha256: hash,
              retryAfterEpochMs: 1234,
            },
          },
        ],
      };
      expect(protocol.syncDemoLedgerSchema.parse(value)).toEqual(value);
    },
  );
  it.each(["operation", "revision"] as const)(
    "rejects duplicated request %s identities across paths",
    (duplicate) => {
      const entries = ["first.md", "second.md"].map((path, index) => ({
        path,
        base: null,
        work: {
          kind: "push",
          certainty: "uncertain",
          operationId:
            duplicate === "operation"
              ? operationId
              : `${index + 1}1111111-1111-4111-8111-111111111111`,
          revision:
            duplicate === "revision"
              ? revision
              : `${index + 1}2222222-2222-4222-8222-222222222222`,
          parent: { kind: "never_seen" },
          contentSha256: hash,
          retryAfterEpochMs: 0,
        },
      }));
      expect(
        protocol.syncDemoLedgerSchema.safeParse({ ...state, entries }).success,
      ).toBe(false);
    },
  );
  it.each([
    { ...state, schemaVersion: 2 },
    { ...state, content: "private body" },
    { ...state, token: "secret" },
    { ...state, cursor: "invalid" },
    { ...state, vaultId: deviceId },
    {
      ...state,
      entries: [
        { path: "ai-bridge-conflicts/demo.md", base: null, work: null },
      ],
    },
    { ...state, entries: [{ path: "démó.md", base: null, work: null }] },
    {
      ...state,
      entries: [...state.entries, { path: "DEMO.md", base: null, work: null }],
    },
    {
      ...state,
      entries: [
        {
          path: "demo.md",
          base: null,
          work: {
            kind: "apply",
            target: { revision, contentSha256: hash },
            expectedHash: hash,
          },
        },
      ],
    },
    {
      ...state,
      entries: [
        {
          path: "demo.md",
          base: null,
          work: {
            kind: "push",
            certainty: "not_admitted",
            operationId,
            revision,
            parent: { kind: "revision", revision },
            contentSha256: hash,
            retryAfterEpochMs: 0,
          },
        },
      ],
    },
  ])(
    "rejects unsupported, unbound or policy-invalid persisted state %#",
    (value) => {
      expect(protocol.syncDemoLedgerSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
});
