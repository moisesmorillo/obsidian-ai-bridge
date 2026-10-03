import { syncVaultMarkerKey } from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";

/** Synthetic legacy object that the isolated sync scan must leave untouched. */
const LEGACY_KEY = "vault/m7-local-runtime-sentinel.md";
/** Stable local test clock beyond real R2 uploaded times, never a Free-tier CPU clock. */
const FIXTURE_EPOCH_MS = 2_000_000_000_000;
/** Strict marker and scan identifiers shared only with this local workerd fixture. */
const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);

/** Actual Worker binding shape used by the composed private store. */
interface RuntimeEnv {
  /** Workerd's local R2 bucket; all conditional predicates are built in this isolate. */
  readonly BUCKET: R2ConditionalBucketPort;
}

/** Runs the nine-method store inside workerd, with no host-proxied conditional Headers. */
export default {
  async fetch(_request: Request, env: RuntimeEnv): Promise<Response> {
    const marker = await encodeSyncRecord({
      kind: "vaultMarker",
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
    });
    await env.BUCKET.put(LEGACY_KEY, "unchanged-legacy-object", {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: { format: "synthetic-legacy" },
      httpMetadata: { contentType: "text/plain" },
    });
    const marked = await env.BUCKET.put(syncVaultMarkerKey(vaultId), marker, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: { format: "sync-v1" },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (marked === null) return Response.json({ error: "marker_refused" });
    const clock = () => FIXTURE_EPOCH_MS;
    const store = () => createSyncR2Store(env.BUCKET, clock, () => 20);
    let result = await store().startInventory({ vaultId, inventoryId });
    let invocations = 1;
    for (const _ of Array.from({ length: 24 })) {
      if (result.kind === "complete" || result.kind === "error") break;
      const started = await store().startInventory({ vaultId, inventoryId });
      invocations += 1;
      if (started.kind === "error") {
        result = started;
        break;
      }
      result = await store().continueInventory({ vaultId, inventoryId });
      invocations += 1;
    }
    const legacy = await env.BUCKET.get(LEGACY_KEY);
    const legacyText =
      legacy === null
        ? null
        : new TextDecoder().decode(await legacy.arrayBuffer());
    if (result.kind !== "complete") {
      return Response.json({ result, invocations, legacyText });
    }
    const page = await store().readInventoryPage({
      vaultId,
      handle: result,
      cursor: "",
    });
    return Response.json({ result, page, invocations, legacyText });
  },
};
