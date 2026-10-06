import type {
  SyncCompleteInventory,
  SyncInventoryResult,
  SyncReadInventoryPageResult,
} from "@core/sync/sync-store.types";
import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
} from "@obsidian-ai-bridge/core";
import {
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryManifestKey,
  syncVaultMarkerKey,
} from "@protocol/sync.codec";
import { SYNC_FEED_LANE_COUNT } from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import { encodeLiveCurrentObject } from "@worker/infrastructure/current-object.codec";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { encodeSyncPublication } from "@worker/infrastructure/sync/sync-publication.codec";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import {
  decodeSyncRecord,
  encodeSyncRecord,
} from "@worker/infrastructure/sync/sync-record.codec";
import { z } from "zod";

/** Closed fault boundaries exercised only in a disposable local isolate. */
const requestSchema = z
  .object({
    headCount: z.union([z.literal(0), z.literal(1)]),
    scenario: z.enum([
      "changed",
      "pending",
      "manifest_before",
      "manifest_lost_reply",
      "manifest_unknown",
      "release_before",
      "release_lost_reply",
      "release_unknown",
      "peer_race",
    ]),
  })
  .strict();
/** Injected clock avoids real waiting; it is not actual-expiry or CPU evidence. */
const NOW = 2_000_000_000_000;
/** Local workerd binding, with predicates constructed in this isolate. */
interface Env {
  readonly BUCKET: R2ConditionalBucketPort;
}

/** Rejects malformed synthetic identifiers without unchecked branding.
 * @param value Validated identifier returned by the existing domain factory.
 * @returns The identifier only when the fixture factory accepted it.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid fixture identifier");
  return value;
}

/** Runs one tiny scenario in a unique vault, never a remote resource or public endpoint. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const input = requestSchema.parse(await request.json());
    const vaultId = syncVaultIdSchema.parse(crypto.randomUUID());
    const inventoryId = syncInventoryIdSchema.parse(
      "22222222-2222-4222-8222-222222222222",
    );
    const peerId = syncInventoryIdSchema.parse(
      "66666666-6666-4666-8666-666666666666",
    );
    const manifestKey = syncInventoryManifestKey(vaultId, inventoryId);
    const activeKey = syncInventoryActiveKey(vaultId);
    const traces: {
      method: "start" | "continue" | "page";
      get: number;
      put: number;
      list: number;
      native: { get: number; put: number; list: number };
    }[] = [];
    let armed = false;
    let fired = false;
    let hideReadback = false;
    let conditionalRefused = false;
    let peerSlotSnapshot: string | null = null;

    /** Creates exact synthetic records outside the store-call measurements.
     * @param key Synthetic key in this disposable fixture's namespace.
     * @param body Strict codec output created once with an absence predicate.
     * @param format Persisted custom-metadata discriminator for sync or current records.
     */
    async function seed(
      key: string,
      body: string | Uint8Array,
      format = "sync-v1",
    ): Promise<void> {
      const result = await env.BUCKET.put(key, body, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        customMetadata: { format },
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (result === null) throw new Error("Fixture create refused");
    }
    /** Captures bytes and exact generation metadata for preservation assertions.
     * @param key Exact seeded or competing key to audit outside store counters.
     * @returns A lossless snapshot of bytes, predicate metadata and custom metadata.
     */
    async function snapshot(key: string): Promise<string> {
      const object = await env.BUCKET.get(key);
      if (object === null) throw new Error("Missing fixture object");
      return JSON.stringify({
        key: object.key,
        etag: object.etag,
        uploaded: object.uploaded.getTime(),
        metadata: object.customMetadata,
        bytes: Array.from(new Uint8Array(await object.arrayBuffer())),
      });
    }
    /** Reads persisted authority through the real strict codec, independently of returned progress.
     * @returns The validated same-ID manifest after the latest store invocation.
     */
    async function manifest() {
      const object = await env.BUCKET.get(manifestKey);
      if (object === null) throw new Error("Missing manifest");
      const record = await decodeSyncRecord(
        "manifest",
        manifestKey,
        new Uint8Array(await object.arrayBuffer()),
        vaultId,
      );
      if (record.kind !== "manifest") throw new Error("Wrong fixture record");
      return record.record;
    }
    /** Observes slot ownership after each boundary without counting audits as store calls.
     * @returns The exact validated slot state, including a competing owner when present.
     */
    async function slot() {
      const object = await env.BUCKET.get(activeKey);
      if (object === null) throw new Error("Missing active slot");
      const record = await decodeSyncRecord(
        "activeSlot",
        activeKey,
        new Uint8Array(await object.arrayBuffer()),
        vaultId,
      );
      if (record.kind !== "activeSlot") throw new Error("Wrong fixture record");
      return record.record;
    }
    /** Runs one scan transition with fresh request-local storage capabilities.
     * @param method Admission or continuation for this stable inventory identity.
     * @returns The real store result without converting unknown evidence to success.
     */
    async function invoke(
      method: "start" | "continue",
    ): Promise<SyncInventoryResult>;
    /** Reads complete-handle evidence through a fresh, independently counted facade.
     * @param method Evidence-page dispatch, separate from scan transitions.
     * @param handle Complete authority returned by the real store after release.
     * @returns Verified evidence or a typed store refusal.
     */
    async function invoke(
      method: "page",
      handle: SyncCompleteInventory,
    ): Promise<SyncReadInventoryPageResult>;
    /** Counts attempts and actual native forwards; setup, peer writes and audits are separate.
     * @param method Public store operation dispatched through a fresh facade.
     * @param handle Required only for evidence paging after verified completion.
     * @returns The unmodified result of that public store invocation.
     */
    async function invoke(
      method: "start" | "continue" | "page",
      handle?: SyncCompleteInventory,
    ) {
      const calls = {
        method,
        get: 0,
        put: 0,
        list: 0,
        native: { get: 0, put: 0, list: 0 },
      };
      const release =
        input.scenario.startsWith("release") || input.scenario === "peer_race";
      const targetKey = release ? activeKey : manifestKey;
      const bucket: R2ConditionalBucketPort = {
        async get(key) {
          calls.get += 1;
          if (hideReadback && key === targetKey)
            throw new Error("Injected unavailable read-back");
          calls.native.get += 1;
          return env.BUCKET.get(key);
        },
        list(options) {
          calls.list += 1;
          calls.native.list += 1;
          return env.BUCKET.list(options);
        },
        async put(key, body, options) {
          calls.put += 1;
          if (!armed || fired || key !== targetKey) {
            calls.native.put += 1;
            return env.BUCKET.put(key, body, options);
          }
          fired = true;
          if (input.scenario.endsWith("before"))
            throw new Error("Injected interruption before binding PUT");
          if (input.scenario === "peer_race") {
            const observed = await env.BUCKET.get(activeKey);
            if (observed === null) throw new Error("Missing race predicate");
            const peer = await encodeSyncRecord({
              kind: "activeSlot",
              record: {
                schemaVersion: 1,
                protocolMajor: 1,
                vaultId,
                state: "active",
                inventoryId: peerId,
              },
            });
            const replaced = await env.BUCKET.put(activeKey, peer, {
              ...options,
              onlyIf: { etagMatches: observed.etag },
            });
            if (replaced === null) throw new Error("Peer race failed");
            peerSlotSnapshot = await snapshot(activeKey);
            calls.native.put += 1;
            const result = await env.BUCKET.put(key, body, options);
            conditionalRefused = result === null;
            return result;
          }
          calls.native.put += 1;
          const result = await env.BUCKET.put(key, body, options);
          if (result === null) throw new Error("Fault target was not applied");
          hideReadback = input.scenario.endsWith("unknown");
          throw new Error("Injected lost binding response after applied PUT");
        },
      };
      const store = createSyncR2Store(
        bucket,
        () => NOW,
        () => 20,
      );
      try {
        if (method === "page") {
          if (handle === undefined) throw new Error("Missing complete handle");
          return await store.readInventoryPage({ vaultId, handle, cursor: "" });
        }
        return await (method === "start"
          ? store.startInventory({ vaultId, inventoryId })
          : store.continueInventory({ vaultId, inventoryId }));
      } finally {
        traces.push(calls);
      }
    }

    await seed(
      syncVaultMarkerKey(vaultId),
      await encodeSyncRecord({
        kind: "vaultMarker",
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
      }),
    );
    const digest = required(
      createContentSha256(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    );
    const operationId = syncOperationIdSchema.parse(
      "44444444-4444-4444-8444-444444444444",
    );
    const path = syncNotePathSchema.parse("synthetic.md");
    if (input.headCount === 1)
      await seed(
        syncHeadKey(vaultId, path),
        await encodeSyncRecord({
          kind: "head",
          record: {
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId,
            path,
            revision: syncRevisionSchema.parse(
              "33333333-3333-4333-8333-333333333333",
            ),
            parent: { kind: "never_seen" },
            kind: "live",
            contentSha256: digest,
            byteSize: 0,
            mediaType: "text/markdown",
            operationId,
            origin: syncDeviceIdSchema.parse(
              "55555555-5555-4555-8555-555555555555",
            ),
          },
        }),
      );
    const v2Key = `vault/${vaultId}/v2-sentinel.md`;
    await seed(
      v2Key,
      encodeLiveCurrentObject({
        kind: "live",
        revision: required(
          createApplicationRevision("33333333-3333-4333-8333-333333333333"),
        ),
        contentSha256: digest,
        content: "",
        receipt: {
          action: "create",
          associationId: required(
            createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
          ),
          operationId: required(createMirrorOperationId(operationId)),
          precondition: { kind: "absent" },
          contentSha256: digest,
        },
      }),
      "2",
    );
    const peerStore = createSyncR2Store(
      env.BUCKET,
      () => NOW,
      () => 20,
    );
    await peerStore.startInventory({ vaultId, inventoryId: peerId });
    const peerKey = syncInventoryManifestKey(vaultId, peerId);
    const peerBefore = await snapshot(peerKey);
    const v2Before = await snapshot(v2Key);
    await invoke("start");
    for (const _ of Array.from({ length: 12 })) {
      const state = await manifest();
      if (
        state.phase === "scanning" &&
        state.cursor === null &&
        state.listPageCount > 0
      )
        break;
      const result = await invoke(
        state.phase === "starting" ? "start" : "continue",
      );
      if (result.kind === "error")
        throw new Error(`Preparation refused: ${result.code}`);
    }
    const ready = await manifest();
    if (
      ready.phase !== "scanning" ||
      ready.cursor !== null ||
      ready.listPageCount === 0 ||
      ready.headCount !== input.headCount
    )
      throw new Error("Preparation did not reach final-vector boundary");

    if (input.scenario === "changed" || input.scenario === "pending") {
      await seed(
        syncFeedLaneHeadKey(vaultId, SYNC_FEED_LANE_COUNT - 1),
        await encodeSyncPublication({
          kind: "laneHead",
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId,
          lane: SYNC_FEED_LANE_COUNT - 1,
          committedSequence: syncSequenceSchema.parse(
            input.scenario === "changed"
              ? "00000000000000000001"
              : "00000000000000000000",
          ),
          committedAtEpochMs: input.scenario === "changed" ? NOW - 1000 : 0,
          ...(input.scenario === "pending"
            ? {
                pending: {
                  operationId,
                  nextSequence: syncEventSequenceSchema.parse(
                    "00000000000000000001",
                  ),
                },
              }
            : {}),
        }),
      );
    }
    const releaseScenario =
      input.scenario.startsWith("release") || input.scenario === "peer_race";
    if (releaseScenario) {
      const finalized = await invoke("continue");
      if (
        finalized.kind !== "inventory_in_progress" ||
        (await manifest()).phase !== "complete"
      )
        throw new Error("Expected persisted completion before release fault");
    }
    const beforeBoundary = await snapshot(manifestKey);
    const beforeSlot = await snapshot(activeKey);
    armed = true;
    const boundary = await invoke("continue");
    const boundaryCalls = traces.at(-1);
    const phaseAtBoundary = (await manifest()).phase;
    const slotAtBoundary = await slot();
    const manifestUnchangedAtBoundary =
      beforeBoundary === (await snapshot(manifestKey));
    const slotUnchangedAtBoundary = beforeSlot === (await snapshot(activeKey));
    armed = false;
    hideReadback = false;
    const recovery = await invoke("continue");
    const recoveryCalls = traces.at(-1);
    const terminal =
      recovery.kind === "complete" || recovery.kind === "error"
        ? recovery
        : await invoke("continue");
    const page =
      terminal.kind === "complete" ? await invoke("page", terminal) : null;
    const finalSlot = await slot();
    return Response.json({
      boundary,
      recovery,
      terminal,
      page,
      fired,
      conditionalRefused,
      phaseAtBoundary,
      slotAtBoundary,
      finalSlot,
      manifestUnchangedAtBoundary,
      slotUnchangedAtBoundary,
      peerSlotPreserved:
        peerSlotSnapshot === null
          ? null
          : peerSlotSnapshot === (await snapshot(activeKey)),
      peerPreserved: peerBefore === (await snapshot(peerKey)),
      v2Preserved: v2Before === (await snapshot(v2Key)),
      boundaryCalls,
      recoveryCalls,
      traces,
    });
  },
};
