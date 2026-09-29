import { createContentSha256 } from "@core/mirror/mirror-identifiers";
import type {
  SyncDeviceId,
  SyncEventSequence,
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
  SyncVaultId,
} from "@core/sync/sync.types";
import {
  evaluateSyncMutation,
  type SyncMutationDecision,
} from "@core/sync/sync-mutation-policy";
import type {
  SyncCurrentState,
  SyncMutationRequest,
  SyncOperationRecord,
} from "@core/sync/sync-store.types";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";
import { describe, expect, it, vi } from "vitest";

const VAULT_ID = "8f4c6a20-2b51-4d86-9c55-df50d9390d96" as SyncVaultId;
const DEVICE_ID = "cb5760e7-b198-441e-b459-7187df4672dc" as SyncDeviceId;
const PATH = "notes/example.md" as SyncNotePath;
const REVISION_1 = "1c79a710-b532-4c32-9e14-cda5fa23a06d" as SyncRevision;
const REVISION_2 = "2c79a710-b532-4c32-9e14-cda5fa23a06d" as SyncRevision;
const REVISION_3 = "3c79a710-b532-4c32-9e14-cda5fa23a06d" as SyncRevision;
const OPERATION_ID = "b03f51ea-581e-4e4a-bec3-b89d4325d7c7" as SyncOperationId;
const OTHER_OPERATION_ID =
  "d03f51ea-581e-4e4a-bec3-b89d4325d7c7" as SyncOperationId;
const DIGEST_VALUE = requiredDigest("a".repeat(64));
const OTHER_DIGEST_VALUE = requiredDigest("b".repeat(64));
const CONTENT = "# original note";
const UPDATED_CONTENT = "# changed note";

const hashContent = vi.fn(async (_content: string) => DIGEST_VALUE);
const neverSeen: SyncCurrentState = { kind: "never_seen" };
const live: SyncCurrentState = {
  kind: "live",
  revision: REVISION_1,
  parent: { kind: "never_seen" },
  contentSha256: DIGEST_VALUE,
  byteSize: new TextEncoder().encode(CONTENT).byteLength,
  mediaType: "text/markdown",
  operationId: OPERATION_ID,
  origin: DEVICE_ID,
};
const tombstone: SyncCurrentState = {
  kind: "tombstone",
  revision: REVISION_2,
  parent: { kind: "revision", revision: REVISION_1 },
  contentSha256: DIGEST_VALUE,
  byteSize: new TextEncoder().encode(CONTENT).byteLength,
  mediaType: "text/markdown",
  operationId: OPERATION_ID,
  origin: DEVICE_ID,
};

const createRequest: SyncMutationRequest = {
  kind: "create",
  vaultId: VAULT_ID,
  path: PATH,
  operationId: OPERATION_ID,
  revision: REVISION_1,
  parent: { kind: "never_seen" },
  contentSha256: DIGEST_VALUE,
  origin: DEVICE_ID,
  content: CONTENT,
  mediaType: "text/markdown",
};
const updateRequest: SyncMutationRequest = {
  kind: "update",
  vaultId: VAULT_ID,
  path: PATH,
  operationId: OTHER_OPERATION_ID,
  revision: REVISION_2,
  parent: { kind: "revision", revision: REVISION_1 },
  contentSha256: DIGEST_VALUE,
  origin: DEVICE_ID,
  content: UPDATED_CONTENT,
  mediaType: "text/markdown",
};
const tombstoneRequest: SyncMutationRequest = {
  kind: "tombstone",
  vaultId: VAULT_ID,
  path: PATH,
  operationId: OTHER_OPERATION_ID,
  revision: REVISION_2,
  parent: { kind: "revision", revision: REVISION_1 },
  contentSha256: DIGEST_VALUE,
  origin: DEVICE_ID,
};

/** Requires every policy outcome to be handled.
 * @param decision Decision returned by the transition policy.
 * @returns Stable text used by the focused assertion.
 */
function decisionLabel(decision: SyncMutationDecision): string {
  switch (decision.kind) {
    case "proceed":
      return decision.kind;
    case "already_committed":
      return decision.position.sequence;
    case "reject":
      return decision.code;
  }
}

/** Builds a previously committed immutable record for exact replay tests.
 * @param request Complete immutable request retained by the journal.
 * @returns Committed evidence with one stable feed position.
 */
function committedRecord(
  request: SyncMutationRequest,
): Extract<SyncOperationRecord, { readonly kind: "committed" }> {
  return {
    kind: "committed",
    request,
    position: {
      lane: 7,
      sequence: "00000000000000000001" as SyncEventSequence,
    },
  };
}

/** Validates lowercase SHA-256 fixture values at test setup.
 * @param value Candidate fixed-width hexadecimal digest.
 * @returns Validated content digest for deterministic tests.
 * @throws Error if the test fixture is not a canonical SHA-256 digest.
 */
function requiredDigest(value: string) {
  const digest = createContentSha256(value);
  if (digest === undefined) {
    throw new Error("Test fixture digest must be lowercase SHA-256.");
  }

  return digest;
}

describe("evaluateSyncMutation", () => {
  it("allows create only for never-seen and updates against the exact live or tombstone parent", async () => {
    const createDecision = await evaluateSyncMutation(
      createRequest,
      neverSeen,
      undefined,
      hashContent,
    );
    const updateDecision = await evaluateSyncMutation(
      updateRequest,
      live,
      undefined,
      hashContent,
    );
    const recreateDecision = await evaluateSyncMutation(
      {
        ...updateRequest,
        revision: REVISION_3,
        parent: { kind: "revision", revision: REVISION_2 },
      },
      tombstone,
      undefined,
      hashContent,
    );
    const tombstoneDecision = await evaluateSyncMutation(
      tombstoneRequest,
      live,
      undefined,
      hashContent,
    );

    expect(createDecision).toEqual({ kind: "proceed" });
    expect(updateDecision).toEqual({ kind: "proceed" });
    expect(recreateDecision).toEqual({ kind: "proceed" });
    expect(tombstoneDecision).toEqual({ kind: "proceed" });
  });

  it("rejects a proposed revision that repeats its parent", async () => {
    const decision = await evaluateSyncMutation(
      { ...updateRequest, revision: REVISION_1 },
      live,
      undefined,
      hashContent,
    );

    expect(decision).toEqual({ kind: "reject", code: "invalid_input" });
  });

  it("rejects stale parents and tombstones without an exact live parent to preserve", async () => {
    const staleUpdate = await evaluateSyncMutation(
      { ...updateRequest, parent: { kind: "revision", revision: REVISION_3 } },
      live,
      undefined,
      hashContent,
    );
    const createOverLive = await evaluateSyncMutation(
      createRequest,
      live,
      undefined,
      hashContent,
    );
    const absentTombstone = await evaluateSyncMutation(
      tombstoneRequest,
      neverSeen,
      undefined,
      hashContent,
    );
    const tombstoneOverTombstone = await evaluateSyncMutation(
      {
        ...tombstoneRequest,
        revision: REVISION_3,
        parent: { kind: "revision", revision: REVISION_2 },
      },
      tombstone,
      undefined,
      hashContent,
    );
    const digestMismatchTombstone = await evaluateSyncMutation(
      { ...tombstoneRequest, contentSha256: OTHER_DIGEST_VALUE },
      live,
      undefined,
      hashContent,
    );

    expect(staleUpdate).toEqual({ kind: "reject", code: "stale_revision" });
    expect(createOverLive).toEqual({ kind: "reject", code: "stale_revision" });
    expect(absentTombstone).toEqual({ kind: "reject", code: "stale_revision" });
    expect(tombstoneOverTombstone).toEqual({
      kind: "reject",
      code: "stale_revision",
    });
    expect(digestMismatchTombstone).toEqual({
      kind: "reject",
      code: "stale_revision",
    });
  });

  it("requires exact content digest and enforces the UTF-8 byte limit before approval", async () => {
    const hashMismatch = await evaluateSyncMutation(
      { ...createRequest, contentSha256: OTHER_DIGEST_VALUE },
      neverSeen,
      undefined,
      hashContent,
    );
    const digestSpy = vi.fn(async (_content: string) => OTHER_DIGEST_VALUE);
    const actualHashMismatch = await evaluateSyncMutation(
      createRequest,
      neverSeen,
      undefined,
      digestSpy,
    );
    const maximumUtf8Content = "é".repeat(MAX_NOTE_SIZE_BYTES / 2);
    const maximumUtf8 = await evaluateSyncMutation(
      { ...createRequest, content: maximumUtf8Content },
      neverSeen,
      undefined,
      hashContent,
    );
    const oversizedContent = `${maximumUtf8Content}a`;
    const oversized = await evaluateSyncMutation(
      { ...createRequest, content: oversizedContent },
      neverSeen,
      undefined,
      hashContent,
    );

    expect(hashMismatch).toEqual({ kind: "reject", code: "invalid_input" });
    expect(actualHashMismatch).toEqual({
      kind: "reject",
      code: "invalid_input",
    });
    expect(digestSpy).toHaveBeenCalledWith(CONTENT);
    expect(maximumUtf8).toEqual({ kind: "proceed" });
    expect(oversized).toEqual({ kind: "reject", code: "invalid_input" });
  });

  it("checks exact operation replay before current state and rejects changed requests", async () => {
    const committed = committedRecord(createRequest);
    const replay = await evaluateSyncMutation(
      createRequest,
      live,
      committed,
      hashContent,
    );
    const changedContent = await evaluateSyncMutation(
      { ...createRequest, content: UPDATED_CONTENT },
      neverSeen,
      committed,
      hashContent,
    );
    const changedParent = await evaluateSyncMutation(
      {
        ...createRequest,
        parent: { kind: "never_seen" },
        revision: REVISION_3,
      },
      neverSeen,
      committed,
      hashContent,
    );
    const changedSameLengthContent = await evaluateSyncMutation(
      { ...createRequest, content: "# original mote" },
      neverSeen,
      committed,
      hashContent,
    );
    const reissuedAsUpdate = await evaluateSyncMutation(
      {
        ...createRequest,
        kind: "update",
        parent: { kind: "revision", revision: REVISION_2 },
      },
      neverSeen,
      committed,
      hashContent,
    );
    const composedRequest = { ...createRequest, content: "Café" };
    const composedRecord = committedRecord(composedRequest);
    const decomposedReplay = await evaluateSyncMutation(
      { ...composedRequest, content: "Cafe\u0301" },
      neverSeen,
      composedRecord,
      hashContent,
    );

    expect(replay).toEqual({
      kind: "already_committed",
      revision: REVISION_1,
      operationId: OPERATION_ID,
      position: committed.position,
    });
    expect(changedContent).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
    expect(changedParent).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
    expect(changedSameLengthContent).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
    expect(reissuedAsUpdate).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
    expect(decomposedReplay).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
  });

  it("rejects changed replay bytes as operation reuse before digest validation", async () => {
    const changedContent = { ...createRequest, content: UPDATED_CONTENT };
    const changedReplay = await evaluateSyncMutation(
      changedContent,
      neverSeen,
      committedRecord(createRequest),
      async () => OTHER_DIGEST_VALUE,
    );

    expect(changedReplay).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
  });

  it("rejects oversized changed replay bytes as operation reuse", async () => {
    const oversizedReplay = await evaluateSyncMutation(
      {
        ...createRequest,
        content: "x".repeat(MAX_NOTE_SIZE_BYTES + 1),
      },
      neverSeen,
      committedRecord(createRequest),
      async () => OTHER_DIGEST_VALUE,
    );

    expect(oversizedReplay).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
  });

  it("validates exact committed replay content before returning success", async () => {
    const invalidExactReplay = await evaluateSyncMutation(
      createRequest,
      live,
      committedRecord(createRequest),
      async () => OTHER_DIGEST_VALUE,
    );

    expect(invalidExactReplay).toEqual({
      kind: "reject",
      code: "invalid_input",
    });
  });

  it("preserves exact committed update and tombstone replays", async () => {
    const updateReplay = await evaluateSyncMutation(
      updateRequest,
      neverSeen,
      committedRecord(updateRequest),
      hashContent,
    );
    const tombstoneReplay = await evaluateSyncMutation(
      tombstoneRequest,
      neverSeen,
      committedRecord(tombstoneRequest),
      hashContent,
    );

    expect(updateReplay).toEqual({
      kind: "already_committed",
      revision: updateRequest.revision,
      operationId: updateRequest.operationId,
      position: committedRecord(updateRequest).position,
    });
    expect(tombstoneReplay).toEqual({
      kind: "already_committed",
      revision: tombstoneRequest.revision,
      operationId: tombstoneRequest.operationId,
      position: committedRecord(tombstoneRequest).position,
    });
  });

  it("rejects an operation replay whose revision parent changed", async () => {
    const changedParent = await evaluateSyncMutation(
      {
        ...updateRequest,
        parent: { kind: "revision", revision: REVISION_3 },
      },
      neverSeen,
      committedRecord(updateRequest),
      hashContent,
    );

    expect(changedParent).toEqual({
      kind: "reject",
      code: "operation_id_reused",
    });
  });

  it("never reports pending or unresolved operation evidence as committed", async () => {
    const pending: SyncOperationRecord = {
      kind: "pending",
      request: createRequest,
    };
    const unknown: SyncOperationRecord = {
      kind: "unknown",
      request: createRequest,
    };

    expect(
      await evaluateSyncMutation(
        createRequest,
        neverSeen,
        pending,
        hashContent,
      ),
    ).toEqual({ kind: "reject", code: "operation_pending" });
    expect(
      await evaluateSyncMutation(
        createRequest,
        neverSeen,
        unknown,
        hashContent,
      ),
    ).toEqual({ kind: "reject", code: "effect_unknown" });
  });

  it("does not mutate request or observation objects", async () => {
    const request = Object.freeze({ ...createRequest });
    const observed = Object.freeze({ ...neverSeen });

    await evaluateSyncMutation(request, observed, undefined, hashContent);

    expect(request).toEqual(createRequest);
    expect(observed).toEqual(neverSeen);
    expect(
      decisionLabel(
        await evaluateSyncMutation(request, observed, undefined, hashContent),
      ),
    ).toBe("proceed");
  });
});
