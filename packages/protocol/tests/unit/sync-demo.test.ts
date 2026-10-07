import {
  createContentSha256,
  SyncDemoService,
  type SyncStore,
} from "@obsidian-ai-bridge/core";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import {
  SYNC_DEMO_BINDING_HEADER,
  SYNC_DEMO_TRANSPORT_ERROR,
} from "@protocol/sync-demo.constants";
import {
  syncDemoBindingHeadersSchema,
  syncDemoRequestSchema,
  syncDemoResponseSchema,
  syncDemoTransportFailureSchema,
} from "@protocol/sync-demo.schemas";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const path = syncNotePathSchema.parse("demo.md");
const revision = syncRevisionSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const operationId = syncOperationIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const origin = syncDeviceIdSchema.parse("44444444-4444-4444-8444-444444444444");
const digest = createContentSha256("a".repeat(64));
if (!digest) throw new Error("Invalid fixture digest");

function fixture() {
  const failure = { kind: "error", code: "storage_unavailable" } as const;
  const store = {
    readCurrent: vi.fn<SyncStore["readCurrent"]>(async () => ({
      kind: "never_seen",
    })),
    readVersion: vi.fn<SyncStore["readVersion"]>(async () => ({
      kind: "absent",
    })),
    mutate: vi.fn<SyncStore["mutate"]>(async () => failure),
    readChanges: vi.fn<SyncStore["readChanges"]>(async () => ({
      kind: "page",
      events: [],
      nextCursor: "next",
    })),
    readRecovery: async () => failure,
    startInventory: async () => failure,
    continueInventory: async () => failure,
    readInventoryPage: async () => failure,
    resumeOperation: async () => failure,
  } satisfies SyncStore;
  const prepare = vi.fn(async () => null);
  return {
    store,
    prepare,
    service: new SyncDemoService(store, vaultId, [path], 16_384, prepare),
  };
}

const command = {
  operation: "mutate",
  mutation: {
    kind: "create",
    path: "demo.md",
    operationId,
    revision,
    parent: { kind: "never_seen" },
    content: "# Exact\r\n",
  },
};

describe("local sync demo contracts and application admission", () => {
  it("validates paired expectations without normalizing or selecting server identity", () => {
    const headers = {
      [SYNC_DEMO_BINDING_HEADER.vaultId]: vaultId,
      [SYNC_DEMO_BINDING_HEADER.origin]: origin,
    };
    expect(syncDemoBindingHeadersSchema.parse({})).toEqual({});
    expect(syncDemoBindingHeadersSchema.parse(headers)).toEqual(headers);
    expect(
      syncDemoBindingHeadersSchema.safeParse({
        [SYNC_DEMO_BINDING_HEADER.vaultId]: vaultId,
      }).success,
    ).toBe(false);
    expect(
      syncDemoBindingHeadersSchema.safeParse({
        ...headers,
        [SYNC_DEMO_BINDING_HEADER.origin]: "invalid",
      }).success,
    ).toBe(false);
    expect(
      syncDemoBindingHeadersSchema.safeParse({
        ...headers,
        extra: "unsupported",
      }).success,
    ).toBe(false);
    const failure = {
      kind: "error",
      code: SYNC_DEMO_TRANSPORT_ERROR.bindingMismatch,
    };
    expect(syncDemoTransportFailureSchema.parse(failure)).toEqual(failure);
    expect(
      syncDemoTransportFailureSchema.safeParse({ ...failure, vaultId }).success,
    ).toBe(false);
    expect(syncDemoResponseSchema.safeParse(failure).success).toBe(false);
  });
  it("admits exact create/update commands but no caller vault, origin, digest or deletion authority", () => {
    expect(syncDemoRequestSchema.parse(command)).toEqual(command);
    for (const extra of [
      { origin },
      { vaultId },
      { contentSha256: "a".repeat(64) },
    ]) {
      expect(
        syncDemoRequestSchema.safeParse({
          ...command,
          mutation: { ...command.mutation, ...extra },
        }).success,
      ).toBe(false);
    }
    expect(
      syncDemoRequestSchema.safeParse({
        ...command,
        mutation: { ...command.mutation, kind: "tombstone" },
      }).success,
    ).toBe(false);
    expect(
      syncDemoRequestSchema.safeParse({ operation: "resume", operationId })
        .success,
    ).toBe(false);
    expect(
      syncDemoRequestSchema.safeParse({
        ...command,
        mutation: { ...command.mutation, content: "é".repeat(8193) },
      }).success,
    ).toBe(false);
    expect(
      syncDemoRequestSchema.safeParse({
        ...command,
        mutation: { ...command.mutation, content: "\uD800" },
      }).success,
    ).toBe(false);
  });

  it("rejects foreign paths before reads and mutation namespace preparation", async () => {
    const { service, store, prepare } = fixture();
    const foreign = syncNotePathSchema.parse("foreign.md");
    expect(await service.readCurrent(foreign)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(
      await service.mutate({
        kind: "create",
        vaultId,
        path: foreign,
        operationId,
        revision,
        origin,
        parent: { kind: "never_seen" },
        content: "x",
        contentSha256: digest,
        mediaType: "text/markdown",
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(store.readCurrent).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not prepare a vault for reads and forwards typed unavailable rather than empty success", async () => {
    const { service, store, prepare } = fixture();
    store.readCurrent.mockResolvedValue({
      kind: "error",
      code: "vault_not_found",
    });
    expect(await service.readCurrent(path)).toEqual({
      kind: "error",
      code: "vault_not_found",
    });
    expect(await service.readVersion(revision)).toEqual({ kind: "absent" });
    expect(await service.readChanges("cursor")).toEqual({
      kind: "page",
      events: [],
      nextCursor: "next",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses oversized verified heads and immutable bytes rather than exposing data outside the lab admission", async () => {
    const { service, store } = fixture();
    const head = {
      kind: "live",
      revision,
      parent: { kind: "never_seen" },
      contentSha256: digest,
      byteSize: 16_385,
      mediaType: "text/markdown",
      operationId,
      origin,
    } as const;
    store.readCurrent.mockResolvedValue(head);
    expect(await service.readCurrent(path)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    store.readCurrent.mockResolvedValue({ ...head, byteSize: 1 });
    expect(await service.readCurrent(path)).toEqual({ ...head, byteSize: 1 });
    store.readVersion.mockResolvedValue({
      kind: "present",
      version: { ...head, vaultId, path, content: "x".repeat(head.byteSize) },
    });
    expect(await service.readVersion(revision)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
  });

  it("refuses foreign immutable versions and foreign feed pages without exposing bytes or advancing a cursor", async () => {
    const { service, store } = fixture();
    const foreign = syncNotePathSchema.parse("foreign.md");
    store.readVersion.mockResolvedValue({
      kind: "present",
      version: {
        kind: "live",
        vaultId,
        path: foreign,
        revision,
        parent: { kind: "never_seen" },
        contentSha256: digest,
        byteSize: 1,
        mediaType: "text/markdown",
        content: "x",
        operationId,
        origin,
      },
    });
    expect(await service.readVersion(revision)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    store.readChanges.mockResolvedValue({
      kind: "page",
      events: [
        {
          kind: "changed",
          lane: 0,
          sequence: syncEventSequenceSchema.parse("00000000000000000001"),
          path: foreign,
          result: { kind: "live", revision },
          operationId,
          origin,
          committedAtEpochMs: 1,
        },
      ],
      nextCursor: "must-not-advance",
    });
    expect(await service.readChanges("original")).toEqual({
      kind: "error",
      code: "invalid_input",
    });
  });

  it("rejects untrusted extra result fields and never decodes a pending mutation as committed", () => {
    expect(
      syncDemoResponseSchema.safeParse({
        kind: "error",
        code: "operation_pending",
        operationId,
        retryAfterEpochMs: 1000,
      }).success,
    ).toBe(true);
    expect(
      syncDemoResponseSchema.safeParse({
        kind: "committed",
        revision,
        operationId,
      }).success,
    ).toBe(false);
    expect(
      syncDemoResponseSchema.safeParse({
        kind: "never_seen",
        content: "secret",
      }).success,
    ).toBe(false);
  });
});
