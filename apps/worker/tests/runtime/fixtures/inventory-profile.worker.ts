import type { SyncStoreFailure } from "@core/sync/sync-store.types";
import { createContentSha256 } from "@obsidian-ai-bridge/core";
import { syncHeadKey, syncVaultMarkerKey } from "@protocol/sync.codec";
import { MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION } from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
} from "@protocol/sync.schemas";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type { SyncHeadRecord } from "@worker/infrastructure/sync/sync-record.types";
import {
  PROFILE_CPU_ALLOWANCE_MS,
  PROFILE_IDS,
  PROFILE_SEED_BATCH,
  profileRequestSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile.contract";

/** Actual local R2 binding, never a remotely configured resource. */
interface ProfileEnv {
  readonly BUCKET: R2ConditionalBucketPort;
}
/** Generates a valid maximum-length path using portable-sized segments and ordered synthetic indices.
 * @param index Bounded deterministic fixture index, not a user vault identifier.
 * @returns Strict synthetic head metadata; no body/version conformance is implied.
 */
export function profileHead(index: number): SyncHeadRecord {
  const digest = createContentSha256(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  if (digest === undefined) throw new RangeError("Invalid synthetic digest.");
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: PROFILE_IDS.vaultId,
    path: syncNotePathSchema.parse(
      `${Array.from({ length: 4 }, () => "p".repeat(170)).join("/")}/${String(index).padStart(6, "0")}${"n".repeat(27)}.md`,
    ),
    revision: syncRevisionSchema.parse(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
    parent: {
      kind: "revision",
      revision: syncRevisionSchema.parse(
        "77777777-7777-4777-8777-777777777777",
      ),
    },
    kind: "live",
    contentSha256: digest,
    byteSize: 0,
    mediaType: "text/markdown",
    operationId: syncOperationIdSchema.parse(
      "44444444-4444-4444-8444-444444444444",
    ),
    origin: syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555"),
  };
}

/** Executes at most one real store method per request; seeding is separate fixture work. */
export default {
  async fetch(request: Request, env: ProfileEnv): Promise<Response> {
    const started = Date.now();
    const calls = { get: 0, list: 0, put: 0 };
    let readBytes = 0;
    let writtenBytes = 0;
    /** Refuses a 401st physical dispatch, independent of the store's own reservation logic.
     * @param method Binding operation about to be dispatched, including rejected promises.
     */
    function count(method: keyof typeof calls): void {
      if (
        calls.get + calls.list + calls.put >=
        MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION
      )
        throw new RangeError("Profile call ceiling reached.");
      calls[method] += 1;
    }
    const bucket: R2ConditionalBucketPort = {
      async get(key) {
        count("get");
        const object = await env.BUCKET.get(key);
        if (object === null) return null;
        return {
          key: object.key,
          size: object.size,
          etag: object.etag,
          uploaded: object.uploaded,
          ...(object.customMetadata === undefined
            ? {}
            : { customMetadata: object.customMetadata }),
          async arrayBuffer() {
            const bytes = await object.arrayBuffer();
            readBytes += bytes.byteLength;
            return bytes;
          },
        };
      },
      list(options) {
        count("list");
        return env.BUCKET.list(options);
      },
      put(key, body, options) {
        count("put");
        writtenBytes +=
          typeof body === "string"
            ? new TextEncoder().encode(body).byteLength
            : body.byteLength;
        return env.BUCKET.put(key, body, options);
      },
    };
    /** Captures binding attempts and wall time without inventing unavailable isolate measurements.
     * @returns Request-local physical calls, consumed body bytes and unqualified measurement labels.
     */
    const metrics = () => ({
      calls,
      readBytes,
      writtenBytes,
      wallMs: Date.now() - started,
      cpu: "unavailable",
      memory: "unavailable",
      clock: "real",
      preflightCpuAllowanceMs: PROFILE_CPU_ALLOWANCE_MS,
    });
    /** Idempotently seeds only the exact canonical bytes; a conflicting object is never adopted.
     * @param key Canonical fixture key inside this disposable emulator.
     * @param bytes Strict deterministic codec output to create or verify exactly.
     */
    async function seed(key: string, bytes: Uint8Array): Promise<void> {
      const existing = await bucket.get(key);
      if (existing !== null) {
        const actual = new Uint8Array(await existing.arrayBuffer());
        if (
          actual.byteLength !== bytes.byteLength ||
          !actual.every((value, index) => value === bytes[index])
        )
          throw new Error("Conflicting fixture bytes.");
        return;
      }
      const written = await bucket.put(key, bytes, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        customMetadata: { format: "sync-v1" },
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (written === null)
        throw new Error("Fixture create refused; reread on continuation.");
    }
    try {
      const input = profileRequestSchema.parse(await request.json());
      if (input.action === "seed") {
        await seed(
          syncVaultMarkerKey(PROFILE_IDS.vaultId),
          await encodeSyncRecord({
            kind: "vaultMarker",
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId: PROFILE_IDS.vaultId,
          }),
        );
        const end = Math.min(
          input.headCount,
          input.offset + PROFILE_SEED_BATCH,
        );
        let maxHeadBytes = 0;
        for (const index of Array.from(
          { length: end - input.offset },
          (_, offset) => input.offset + offset,
        )) {
          const head = profileHead(index);
          const bytes = await encodeSyncRecord({ kind: "head", record: head });
          await seed(syncHeadKey(PROFILE_IDS.vaultId, head.path), bytes);
          maxHeadBytes = Math.max(maxHeadBytes, bytes.byteLength);
        }
        return Response.json({
          action: "seed",
          nextOffset: end,
          maxHeadBytes,
          metrics: metrics(),
        });
      }
      /** Preserves a supplied uncertainty floor without interpreting the domain refusal as success.
       * @param failure Exact observed core refusal.
       * @returns Conservative fixture failure with its known scheduling bound and call evidence.
       */
      function failed(failure: SyncStoreFailure) {
        return {
          action: "failed",
          ...("retryAfterEpochMs" in failure &&
          failure.retryAfterEpochMs !== undefined
            ? { retryAfterEpochMs: failure.retryAfterEpochMs }
            : {}),
          metrics: metrics(),
        };
      }
      const store = createSyncR2Store(
        bucket,
        Date.now,
        () => PROFILE_CPU_ALLOWANCE_MS,
      );
      if (input.action === "page") {
        const result = await store.readInventoryPage({
          vaultId: PROFILE_IDS.vaultId,
          handle: input.handle,
          cursor: input.cursor,
        });
        return Response.json(
          result.kind === "error"
            ? failed(result)
            : { action: "page", result, metrics: metrics() },
        );
      }
      const result =
        input.action === "start"
          ? await store.startInventory(PROFILE_IDS)
          : await store.continueInventory(PROFILE_IDS);
      return Response.json(
        result.kind === "error"
          ? failed(result)
          : { action: "inventory", result, metrics: metrics() },
      );
    } catch {
      return Response.json(
        { action: "failed", metrics: metrics() },
        { status: 400 },
      );
    }
  },
};
