import type {
  ContentSha256,
  SyncChangeEvent,
  SyncContinueInventoryInput,
  SyncCurrentState,
  SyncEventSequence,
  SyncInventoryResult,
  SyncMutationRequest,
  SyncMutationResult,
  SyncMutationSuccess,
  SyncNotePath,
  SyncOperationId,
  SyncOperationRecord,
  SyncReadChangesInput,
  SyncReadChangesResult,
  SyncReadCurrentInput,
  SyncReadCurrentResult,
  SyncReadInventoryPageInput,
  SyncReadInventoryPageResult,
  SyncReadRecoveryInput,
  SyncReadRecoveryResult,
  SyncReadVersionInput,
  SyncReadVersionResult,
  SyncRecoveryRecord,
  SyncResumeOperationInput,
  SyncResumeOperationResult,
  SyncRevision,
  SyncStartInventoryInput,
  SyncStore,
  SyncStoreFailure,
  SyncVaultId,
  SyncVersionRecord,
} from "@obsidian-ai-bridge/core";
import {
  createContentSha256,
  evaluateSyncMutation,
} from "@obsidian-ai-bridge/core";
import {
  SYNC_SEQUENCE_WIDTH,
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncFeedLaneForPath,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const VAULT_ID = syncVaultIdSchema.parse(
  "8f4c6a20-2b51-4d86-9c55-df50d9390d96",
);
const OTHER_VAULT_ID = syncVaultIdSchema.parse(
  "9f4c6a20-2b51-4d86-9c55-df50d9390d96",
);
const DEVICE_ID = syncDeviceIdSchema.parse(
  "cb5760e7-b198-441e-b459-7187df4672dc",
);
const PATH = syncNotePathSchema.parse("notes/example.md");
const OTHER_PATH = syncNotePathSchema.parse("notes/other.md");
const OPERATION_ID_1 = syncOperationIdSchema.parse(
  "b03f51ea-581e-4e4a-bec3-b89d4325d7c7",
);
const OPERATION_ID_2 = syncOperationIdSchema.parse(
  "d03f51ea-581e-4e4a-bec3-b89d4325d7c7",
);
const OPERATION_ID_3 = syncOperationIdSchema.parse(
  "e03f51ea-581e-4e4a-bec3-b89d4325d7c7",
);
const REVISION_1 = syncRevisionSchema.parse(
  "1c79a710-b532-4c32-9e14-cda5fa23a06d",
);
const REVISION_2 = syncRevisionSchema.parse(
  "2c79a710-b532-4c32-9e14-cda5fa23a06d",
);
const REVISION_3 = syncRevisionSchema.parse(
  "3c79a710-b532-4c32-9e14-cda5fa23a06d",
);
const CONTENT_INITIAL = "# initial\n";
const CONTENT_CHANGED = "# altered\n";

type FakeEffect = "commit" | "pending" | "unknown";

interface InMemorySyncStoreHooks {
  readonly clock: () => number;
  readonly hashContent: (content: string) => Promise<ContentSha256>;
  readonly effect: (
    request: SyncMutationRequest,
  ) => FakeEffect | Promise<FakeEffect>;
}

const deterministicClock = (): (() => number) => {
  let now = 1_800_000_000_000;
  return () => {
    now += 1;
    return now;
  };
};

/** Hashes exact UTF-8 bytes with Web Crypto so changed bytes cannot reuse a digest.
 * @param content Exact Markdown text supplied by the mutation.
 * @returns Its validated SHA-256 digest over UTF-8 bytes.
 */
async function hashContent(content: string): Promise<ContentSha256> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const contentSha256 = createContentSha256(hexadecimal);
  if (contentSha256 === undefined) {
    throw new Error("Web Crypto returned an invalid SHA-256 digest.");
  }

  return contentSha256;
}

function makeHooks(
  effect: InMemorySyncStoreHooks["effect"] = () => "commit",
): InMemorySyncStoreHooks {
  return { clock: deterministicClock(), hashContent, effect };
}

async function createRequest(
  operationId = OPERATION_ID_1,
  revision = REVISION_1,
  content = CONTENT_INITIAL,
  vaultId = VAULT_ID,
): Promise<SyncMutationRequest> {
  return {
    kind: "create",
    vaultId,
    path: PATH,
    operationId,
    revision,
    parent: { kind: "never_seen" },
    contentSha256: await hashContent(content),
    origin: DEVICE_ID,
    content,
    mediaType: "text/markdown",
  };
}

async function updateRequest(
  parentRevision: SyncRevision,
  operationId: SyncOperationId,
  revision: SyncRevision,
  content: string,
): Promise<SyncMutationRequest> {
  return {
    kind: "update",
    vaultId: VAULT_ID,
    path: PATH,
    operationId,
    revision,
    parent: { kind: "revision", revision: parentRevision },
    contentSha256: await hashContent(content),
    origin: DEVICE_ID,
    content,
    mediaType: "text/markdown",
  };
}

async function tombstoneRequest(
  parentRevision: SyncRevision,
  operationId: SyncOperationId,
  revision: SyncRevision,
  contentSha256: ContentSha256,
): Promise<SyncMutationRequest> {
  return {
    kind: "tombstone",
    vaultId: VAULT_ID,
    path: PATH,
    operationId,
    revision,
    parent: { kind: "revision", revision: parentRevision },
    contentSha256,
    origin: DEVICE_ID,
  };
}

function committed(result: SyncMutationResult): SyncMutationSuccess {
  if (result.kind !== "committed") {
    throw new Error(`Expected committed mutation, got ${result.kind}.`);
  }

  return result;
}

type UnresolvedSyncOperation = Extract<
  SyncOperationRecord,
  { readonly kind: "pending" | "unknown" }
>;

interface InMemoryVaultState {
  readonly heads: Map<SyncNotePath, SyncVersionRecord>;
  readonly versions: Map<SyncRevision, SyncVersionRecord>;
  readonly recoveries: Map<SyncOperationId, SyncRecoveryRecord>;
  readonly operations: Map<SyncOperationId, SyncOperationRecord>;
  readonly nextLaneSequences: Map<number, number>;
  readonly committedEvents: SyncChangeEvent[];
}

/**
 * Test-only port fake for exact-parent and operation replay scenarios. Its
 * serialized critical section is not durable multi-key CAS; feed cursors and
 * inventory traversal are intentionally unsupported and remain M7.3/M7.4 work.
 */
class InMemorySyncStore implements SyncStore {
  readonly #hooks: InMemorySyncStoreHooks;
  readonly #vaults = new Map<SyncVaultId, InMemoryVaultState>();
  readonly #vaultLocks = new Map<SyncVaultId, Promise<void>>();

  constructor(hooks: InMemorySyncStoreHooks) {
    this.#hooks = hooks;
  }

  async readCurrent(
    input: SyncReadCurrentInput,
  ): Promise<SyncReadCurrentResult> {
    return this.withVaultCriticalSection(input.vaultId, async () => {
      const vault = this.vaultState(input.vaultId);
      const blocker = this.blockingOperation(vault, input.path);
      if (blocker !== undefined) return failureForOperation(blocker);

      return currentState(vault.heads.get(input.path));
    });
  }

  async mutate(request: SyncMutationRequest): Promise<SyncMutationResult> {
    const boundRequest = snapshotRequest(request);
    return this.withVaultCriticalSection(boundRequest.vaultId, async () => {
      const vault = this.vaultState(boundRequest.vaultId);
      const priorOperation = vault.operations.get(boundRequest.operationId);
      if (priorOperation === undefined) {
        const blocker = this.blockingOperation(vault, boundRequest.path);
        if (blocker !== undefined) return failureForOperation(blocker);
      }

      const decision = await evaluateSyncMutation(
        boundRequest,
        currentState(vault.heads.get(boundRequest.path)),
        priorOperation,
        this.#hooks.hashContent,
      );
      if (decision.kind === "reject") {
        switch (decision.code) {
          case "operation_pending":
            return {
              kind: "error",
              code: "operation_pending",
              operationId: boundRequest.operationId,
            };
          case "effect_unknown":
            return {
              kind: "error",
              code: "effect_unknown",
              operationId: boundRequest.operationId,
            };
          case "invalid_input":
          case "stale_revision":
          case "operation_id_reused":
            return { kind: "error", code: decision.code };
        }
      }
      if (decision.kind === "already_committed") {
        return {
          kind: "committed",
          revision: decision.revision,
          operationId: decision.operationId,
          position: decision.position,
        };
      }
      if (vault.versions.has(boundRequest.revision)) {
        return { kind: "error", code: "invalid_input" };
      }

      const pending: SyncOperationRecord = {
        kind: "pending",
        request: boundRequest,
      };
      vault.operations.set(boundRequest.operationId, pending);

      let effect: FakeEffect;
      try {
        effect = await this.#hooks.effect(boundRequest);
      } catch {
        const unknown: SyncOperationRecord = {
          kind: "unknown",
          request: boundRequest,
        };
        vault.operations.set(boundRequest.operationId, unknown);
        return {
          kind: "error",
          code: "effect_unknown",
          operationId: boundRequest.operationId,
        };
      }

      if (effect === "pending") {
        return {
          kind: "error",
          code: "operation_pending",
          operationId: boundRequest.operationId,
        };
      }
      if (effect === "unknown") {
        vault.operations.set(boundRequest.operationId, {
          kind: "unknown",
          request: boundRequest,
        });
        return {
          kind: "error",
          code: "effect_unknown",
          operationId: boundRequest.operationId,
        };
      }

      const nextVersion = this.nextVersion(vault, boundRequest);
      if (nextVersion.kind === "error") {
        vault.operations.set(boundRequest.operationId, {
          kind: "unknown",
          request: boundRequest,
        });
        return {
          kind: "error",
          code: "effect_unknown",
          operationId: boundRequest.operationId,
        };
      }

      const lane = await syncFeedLaneForPath(boundRequest.path);
      const sequenceNumber = (vault.nextLaneSequences.get(lane) ?? 0) + 1;
      const sequence = syncEventSequenceSchema.parse(
        String(sequenceNumber).padStart(SYNC_SEQUENCE_WIDTH, "0"),
      );
      const position = { lane, sequence } satisfies {
        readonly lane: number;
        readonly sequence: SyncEventSequence;
      };
      const event: SyncChangeEvent = {
        kind: "changed",
        lane,
        sequence,
        path: boundRequest.path,
        result:
          nextVersion.version.kind === "live"
            ? { kind: "live", revision: nextVersion.version.revision }
            : { kind: "tombstone", revision: nextVersion.version.revision },
        operationId: boundRequest.operationId,
        origin: boundRequest.origin,
        committedAtEpochMs: this.#hooks.clock(),
      };
      const committed: SyncOperationRecord = {
        kind: "committed",
        request: boundRequest,
        position,
      };

      vault.versions.set(nextVersion.version.revision, nextVersion.version);
      vault.heads.set(boundRequest.path, nextVersion.version);
      if (nextVersion.recovery !== undefined) {
        vault.recoveries.set(boundRequest.operationId, nextVersion.recovery);
      }
      vault.nextLaneSequences.set(lane, sequenceNumber);
      vault.committedEvents.push(event);
      vault.operations.set(boundRequest.operationId, committed);

      return {
        kind: "committed",
        revision: boundRequest.revision,
        operationId: boundRequest.operationId,
        position,
      };
    });
  }

  async readVersion(
    input: SyncReadVersionInput,
  ): Promise<SyncReadVersionResult> {
    const vault = this.vaultState(input.vaultId);
    const version = vault.versions.get(input.revision);
    if (version !== undefined) return { kind: "present", version };

    const unresolvedOperation = Array.from(vault.operations.values()).find(
      (operation): operation is UnresolvedSyncOperation =>
        operation.kind !== "committed" &&
        operation.request.revision === input.revision,
    );
    return unresolvedOperation === undefined
      ? { kind: "absent" }
      : failureForOperation(unresolvedOperation);
  }

  async readRecovery(
    input: SyncReadRecoveryInput,
  ): Promise<SyncReadRecoveryResult> {
    const vault = this.vaultState(input.vaultId);
    const recovery = vault.recoveries.get(input.operationId);
    if (recovery !== undefined) return { kind: "present", recovery };

    const operation = vault.operations.get(input.operationId);
    return operation !== undefined &&
      operation.kind !== "committed" &&
      operation.request.kind === "tombstone"
      ? failureForOperation(operation)
      : { kind: "absent" };
  }

  /** Refuses cursor reads because this fake does not implement feed traversal.
   * @param _input Vault-bound cursor request that this fake cannot validate.
   * @returns A closed failure instead of an unqualified empty-success page.
   */
  async readChanges(
    _input: SyncReadChangesInput,
  ): Promise<SyncReadChangesResult> {
    return { kind: "error", code: "invalid_cursor" };
  }

  /** Refuses scans because this fake does not persist inventory manifests.
   * @param _input Stable scan identity that this fake cannot persist.
   * @returns An incomplete failure rather than a fabricated complete snapshot.
   */
  async startInventory(
    _input: SyncStartInventoryInput,
  ): Promise<SyncInventoryResult> {
    return { kind: "error", code: "inventory_incomplete" };
  }

  /** Refuses continuation without durable scan progress.
   * @param _input Exact scan identity that this fake cannot resume.
   * @returns An incomplete failure rather than a fabricated complete snapshot.
   */
  async continueInventory(
    _input: SyncContinueInventoryInput,
  ): Promise<SyncInventoryResult> {
    return { kind: "error", code: "inventory_incomplete" };
  }

  /** Refuses evidence reads because this fake has no verified inventory chunks.
   * @param _input Complete-handle request that this fake cannot validate.
   * @returns An incomplete failure instead of an unverified evidence page.
   */
  async readInventoryPage(
    _input: SyncReadInventoryPageInput,
  ): Promise<SyncReadInventoryPageResult> {
    return { kind: "error", code: "inventory_incomplete" };
  }

  async resumeOperation(
    input: SyncResumeOperationInput,
  ): Promise<SyncResumeOperationResult> {
    const operation = this.vaultState(input.vaultId).operations.get(
      input.operationId,
    );
    if (operation === undefined)
      return { kind: "error", code: "invalid_input" };

    switch (operation.kind) {
      case "pending":
        return {
          kind: "error",
          code: "operation_pending",
          operationId: input.operationId,
        };
      case "unknown":
        return {
          kind: "error",
          code: "effect_unknown",
          operationId: input.operationId,
        };
      case "committed":
        return {
          kind: "committed",
          revision: operation.request.revision,
          operationId: operation.request.operationId,
          position: operation.position,
        };
    }
  }

  /** Exposes only a count for assertions that uncertain writes do not advance this fake feed.
   * @param vaultId Validated vault whose in-memory committed events are counted.
   * @returns The number of committed change records; no page or cursor semantics are implied.
   */
  feedEventCount(vaultId: SyncVaultId): number {
    return this.vaultState(vaultId).committedEvents.length;
  }

  private vaultState(vaultId: SyncVaultId): InMemoryVaultState {
    const existing = this.#vaults.get(vaultId);
    if (existing !== undefined) return existing;

    const created: InMemoryVaultState = {
      heads: new Map(),
      versions: new Map(),
      recoveries: new Map(),
      operations: new Map(),
      nextLaneSequences: new Map(),
      committedEvents: [],
    };
    this.#vaults.set(vaultId, created);
    return created;
  }

  private blockingOperation(
    vault: InMemoryVaultState,
    path: SyncNotePath,
  ): UnresolvedSyncOperation | undefined {
    return Array.from(vault.operations.values()).find(
      (operation): operation is UnresolvedSyncOperation =>
        operation.request.path === path && operation.kind !== "committed",
    );
  }

  private nextVersion(
    vault: InMemoryVaultState,
    request: SyncMutationRequest,
  ):
    | {
        readonly kind: "version";
        readonly version: SyncVersionRecord;
        readonly recovery?: SyncRecoveryRecord;
      }
    | { readonly kind: "error" } {
    if (request.kind !== "tombstone") {
      return {
        kind: "version",
        version: {
          kind: "live",
          vaultId: request.vaultId,
          path: request.path,
          revision: request.revision,
          parent: request.parent,
          contentSha256: request.contentSha256,
          byteSize: new TextEncoder().encode(request.content).byteLength,
          mediaType: request.mediaType,
          content: request.content,
          operationId: request.operationId,
          origin: request.origin,
        },
      };
    }

    const source = vault.versions.get(request.parent.revision);
    if (source?.kind !== "live") return { kind: "error" };

    const recovery: SyncRecoveryRecord = {
      vaultId: request.vaultId,
      path: request.path,
      operationId: request.operationId,
      sourceRevision: source.revision,
      contentSha256: source.contentSha256,
      byteSize: source.byteSize,
      mediaType: source.mediaType,
      content: source.content,
      origin: source.origin,
    };

    return {
      kind: "version",
      version: {
        kind: "tombstone",
        vaultId: request.vaultId,
        path: request.path,
        revision: request.revision,
        parent: request.parent,
        contentSha256: request.contentSha256,
        byteSize: source.byteSize,
        mediaType: source.mediaType,
        operationId: request.operationId,
        origin: request.origin,
      },
      recovery,
    };
  }

  private async withVaultCriticalSection<Result>(
    vaultId: SyncVaultId,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#vaultLocks.get(vaultId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#vaultLocks.set(vaultId, queued);
    await previous;

    try {
      return await operation();
    } finally {
      release?.();
      if (this.#vaultLocks.get(vaultId) === queued) {
        this.#vaultLocks.delete(vaultId);
      }
    }
  }
}

function snapshotRequest(request: SyncMutationRequest): SyncMutationRequest {
  switch (request.kind) {
    case "create":
      return Object.freeze({
        ...request,
        parent: Object.freeze({ ...request.parent }),
      });
    case "update":
    case "tombstone":
      return Object.freeze({
        ...request,
        parent: Object.freeze({ ...request.parent }),
      });
  }
}

function currentState(
  version: SyncVersionRecord | undefined,
): SyncCurrentState {
  if (version === undefined) return { kind: "never_seen" };
  if (version.kind === "live") {
    return {
      kind: "live",
      revision: version.revision,
      parent: version.parent,
      contentSha256: version.contentSha256,
      byteSize: version.byteSize,
      mediaType: version.mediaType,
      operationId: version.operationId,
      origin: version.origin,
    };
  }

  return {
    kind: "tombstone",
    revision: version.revision,
    parent: version.parent,
    contentSha256: version.contentSha256,
    byteSize: version.byteSize,
    mediaType: version.mediaType,
    operationId: version.operationId,
    origin: version.origin,
  };
}

function failureForOperation(
  operation: UnresolvedSyncOperation,
): SyncStoreFailure {
  switch (operation.kind) {
    case "pending":
      return {
        kind: "error",
        code: "operation_pending",
        operationId: operation.request.operationId,
      };
    case "unknown":
      return {
        kind: "error",
        code: "effect_unknown",
        operationId: operation.request.operationId,
      };
  }
}

describe("InMemorySyncStore contract fake", () => {
  it("scopes operation identities and current heads by validated vault", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const firstVaultRequest = await createRequest();
    const secondVaultRequest = await createRequest(
      OPERATION_ID_1,
      REVISION_1,
      CONTENT_INITIAL,
      OTHER_VAULT_ID,
    );

    const first = committed(await store.mutate(firstVaultRequest));
    const second = committed(await store.mutate(secondVaultRequest));

    expect(second.position.sequence).toBe(first.position.sequence);
    expect(
      await store.readCurrent({ vaultId: OTHER_VAULT_ID, path: PATH }),
    ).toMatchObject({
      kind: "live",
      revision: REVISION_1,
    });
    expect(store.feedEventCount(VAULT_ID)).toBe(1);
    expect(store.feedEventCount(OTHER_VAULT_ID)).toBe(1);
  });

  it.each([
    ["pending", "operation_pending"],
    ["unknown", "effect_unknown"],
  ] as const)(
    "does not prove matching version or recovery absence for a tombstone with %s effect",
    async (effect, code) => {
      let effectCalls = 0;
      const store = new InMemorySyncStore(
        makeHooks(() => {
          effectCalls += 1;
          return effectCalls === 1 ? "commit" : effect;
        }),
      );
      const initial = await createRequest();
      committed(await store.mutate(initial));
      const tombstone = await tombstoneRequest(
        REVISION_1,
        OPERATION_ID_2,
        REVISION_2,
        initial.contentSha256,
      );

      expect(await store.mutate(tombstone)).toEqual({
        kind: "error",
        code,
        operationId: OPERATION_ID_2,
      });
      const matchingReads = await Promise.all([
        store.readVersion({ vaultId: VAULT_ID, revision: REVISION_2 }),
        store.readRecovery({
          vaultId: VAULT_ID,
          operationId: OPERATION_ID_2,
        }),
      ]);
      const unresolvedFailure = {
        kind: "error",
        code,
        operationId: OPERATION_ID_2,
      };
      expect(matchingReads).toEqual([unresolvedFailure, unresolvedFailure]);
      expect(
        await store.readVersion({ vaultId: VAULT_ID, revision: REVISION_3 }),
      ).toEqual({ kind: "absent" });
      expect(
        await store.readRecovery({
          vaultId: VAULT_ID,
          operationId: OPERATION_ID_3,
        }),
      ).toEqual({ kind: "absent" });
      expect(
        await store.readVersion({
          vaultId: OTHER_VAULT_ID,
          revision: REVISION_2,
        }),
      ).toEqual({ kind: "absent" });
      expect(
        await store.readRecovery({
          vaultId: OTHER_VAULT_ID,
          operationId: OPERATION_ID_2,
        }),
      ).toEqual({ kind: "absent" });
    },
  );

  it("refuses a revision collision across paths without changing prior evidence", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const originalRequest = await createRequest();
    const originalSuccess = committed(await store.mutate(originalRequest));
    const collisionRequest = {
      ...(await createRequest(OPERATION_ID_2, REVISION_1, CONTENT_CHANGED)),
      path: OTHER_PATH,
    };

    expect(await store.mutate(collisionRequest)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(
      await store.readVersion({ vaultId: VAULT_ID, revision: REVISION_1 }),
    ).toMatchObject({
      kind: "present",
      version: {
        path: PATH,
        content: CONTENT_INITIAL,
      },
    });
    expect(
      await store.readCurrent({ vaultId: VAULT_ID, path: PATH }),
    ).toMatchObject({ kind: "live", revision: REVISION_1 });
    expect(
      await store.readCurrent({ vaultId: VAULT_ID, path: OTHER_PATH }),
    ).toEqual({ kind: "never_seen" });
    expect(await store.mutate(originalRequest)).toEqual(originalSuccess);
    expect(store.feedEventCount(VAULT_ID)).toBe(1);
  });

  it("allows exactly one simultaneous create against never-seen absence", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const requests = await Promise.all([
      createRequest(OPERATION_ID_1, REVISION_1),
      createRequest(OPERATION_ID_2, REVISION_2),
    ]);

    const outcomes = await Promise.all(
      requests.map((request) => store.mutate(request)),
    );
    const successes = outcomes.filter((result) => result.kind === "committed");
    const stale = outcomes.filter(
      (result) => result.kind === "error" && result.code === "stale_revision",
    );

    expect(successes).toHaveLength(1);
    expect(stale).toHaveLength(1);
    const winner = successes.at(0);
    if (winner === undefined)
      throw new Error("A successful concurrent create is required.");
    expect(
      await store.readCurrent({ vaultId: VAULT_ID, path: PATH }),
    ).toMatchObject({
      kind: "live",
      revision: committed(winner).revision,
    });
    expect(store.feedEventCount(VAULT_ID)).toBe(1);
  });

  it("allows exactly one simultaneous update against an exact revision parent", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const initial = await createRequest();
    committed(await store.mutate(initial));
    const updates = await Promise.all([
      updateRequest(REVISION_1, OPERATION_ID_2, REVISION_2, CONTENT_CHANGED),
      updateRequest(REVISION_1, OPERATION_ID_3, REVISION_3, "# revised\n"),
    ]);

    const outcomes = await Promise.all(
      updates.map((request) => store.mutate(request)),
    );
    const successes = outcomes.filter((result) => result.kind === "committed");
    const stale = outcomes.filter(
      (result) => result.kind === "error" && result.code === "stale_revision",
    );

    expect(successes).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(store.feedEventCount(VAULT_ID)).toBe(2);
    const winner = successes.at(0);
    if (winner === undefined)
      throw new Error("A successful concurrent update is required.");
    expect(
      await store.readCurrent({ vaultId: VAULT_ID, path: PATH }),
    ).toMatchObject({
      kind: "live",
      revision: committed(winner).revision,
    });
  });

  it("replays an exact operation at the same position and rejects changed bytes", async () => {
    let effectCalls = 0;
    const store = new InMemorySyncStore(
      makeHooks(() => {
        effectCalls += 1;
        return "commit";
      }),
    );
    const request = await createRequest();

    const first = committed(await store.mutate(request));
    const replay = committed(await store.mutate(request));
    const changedRequest = await createRequest(
      OPERATION_ID_1,
      REVISION_1,
      CONTENT_CHANGED,
    );
    const reused = await store.mutate(changedRequest);

    expect(replay).toEqual(first);
    expect(reused).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
    expect(effectCalls).toBe(1);
    expect(store.feedEventCount(VAULT_ID)).toBe(1);
  });

  it("does not let a stale tombstone remove a newer live revision", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const initial = await createRequest();
    committed(await store.mutate(initial));
    const update = await updateRequest(
      REVISION_1,
      OPERATION_ID_2,
      REVISION_2,
      CONTENT_CHANGED,
    );
    committed(await store.mutate(update));

    const staleTombstone = await tombstoneRequest(
      REVISION_1,
      OPERATION_ID_3,
      REVISION_3,
      initial.contentSha256,
    );
    const result = await store.mutate(staleTombstone);
    const current = await store.readCurrent({ vaultId: VAULT_ID, path: PATH });
    const version = await store.readVersion({
      vaultId: VAULT_ID,
      revision: REVISION_2,
    });

    expect(result).toEqual({ kind: "error", code: "stale_revision" });
    expect(current).toMatchObject({ kind: "live", revision: REVISION_2 });
    expect(version).toMatchObject({
      kind: "present",
      version: { kind: "live", content: CONTENT_CHANGED },
    });
    expect(store.feedEventCount(VAULT_ID)).toBe(2);
  });

  it.each([
    ["pending", "operation_pending"],
    ["unknown", "effect_unknown"],
  ] as const)(
    "does not publish a %s effect or expose never-seen absence",
    async (effect, code) => {
      const store = new InMemorySyncStore(makeHooks(() => effect));
      const request = await createRequest();

      const result = await store.mutate(request);
      const current = await store.readCurrent({
        vaultId: VAULT_ID,
        path: PATH,
      });
      const resumed = await store.resumeOperation({
        vaultId: VAULT_ID,
        operationId: OPERATION_ID_1,
      });

      expect(result).toEqual({
        kind: "error",
        code,
        operationId: OPERATION_ID_1,
      });
      expect(current).toEqual({
        kind: "error",
        code,
        operationId: OPERATION_ID_1,
      });
      expect(resumed).toEqual(result);
      expect(store.feedEventCount(VAULT_ID)).toBe(0);
      expect(result.kind).not.toBe("committed");
    },
  );

  it("retains exact source bytes as recovery evidence for a committed tombstone", async () => {
    const store = new InMemorySyncStore(makeHooks());
    const initial = await createRequest();
    committed(await store.mutate(initial));
    const tombstone = await tombstoneRequest(
      REVISION_1,
      OPERATION_ID_2,
      REVISION_2,
      initial.contentSha256,
    );

    const deleted = await store.mutate(tombstone);
    const recovery = await store.readRecovery({
      vaultId: VAULT_ID,
      operationId: OPERATION_ID_2,
    });

    expect(deleted).toMatchObject({ kind: "committed", revision: REVISION_2 });
    expect(recovery).toMatchObject({
      kind: "present",
      recovery: {
        sourceRevision: REVISION_1,
        contentSha256: initial.contentSha256,
        byteSize: new TextEncoder().encode(CONTENT_INITIAL).byteLength,
        content: CONTENT_INITIAL,
      },
    });
    expect(store.feedEventCount(VAULT_ID)).toBe(2);
  });
});
