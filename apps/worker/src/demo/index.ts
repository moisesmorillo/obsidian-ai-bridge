import {
  SyncDemoService,
  type SyncStoreFailure,
} from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_DEMO_CONTENT_BYTES,
  SYNC_PROTOCOL_MAJOR,
  syncVaultMarkerKey,
} from "@obsidian-ai-bridge/protocol";
import { createSyncDemoApp } from "@worker/demo/demo-app";
import type { SyncDemoConfiguration } from "@worker/demo/demo-configuration";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { sha256Content } from "@worker/storage/storage-crypto";

/** Bindings exist only in the separate local-demo configuration, not the release Worker. */
interface SyncDemoEnvironment {
  /** Local synthetic R2 emulator, deliberately not VAULT_BUCKET. */
  readonly DEMO_BUCKET: R2ConditionalBucketPort;
  /** Explicitly armed namespace and three participant identities. */
  readonly DEMO_CONFIGURATION?: string;
  /** Digest-only disposable credentials; no existing production registry fallback. */
  readonly DEMO_CREDENTIAL_REGISTRY?: string;
}
/** Bound for the tiny strict marker; oversized or divergent objects are never repaired. */
const MAX_DEMO_MARKER_BYTES = 512;

/** Creates only the configured fresh marker on admitted mutation; existing bytes must match exactly.
 * @param bucket Isolated local-emulator binding, never the existing vault binding.
 * @param configuration Validated immutable lab namespace.
 * @returns Null only on exact marker proof, otherwise a typed failure and any known retry floor.
 */
async function prepareDemoVault(
  bucket: R2ConditionalBucketPort,
  configuration: SyncDemoConfiguration,
): Promise<SyncStoreFailure | null> {
  const key = createSyncR2Key(
    syncVaultMarkerKey(configuration.vaultId),
    configuration.vaultId,
  );
  if (!key) return { kind: "error", code: "invalid_input" };
  const objects = syncR2ObjectStore(bucket, Date.now);
  const expected = await encodeSyncRecord({
    kind: "vaultMarker",
    schemaVersion: SYNC_PROTOCOL_MAJOR,
    protocolMajor: SYNC_PROTOCOL_MAJOR,
    vaultId: configuration.vaultId,
  });
  const read = await objects.read(key, MAX_DEMO_MARKER_BYTES);
  if (read.kind === "unavailable")
    return { kind: "error", code: "storage_unavailable" };
  if (read.kind === "observed") {
    const bytes = read.observation.bytes;
    return bytes.length === expected.length &&
      bytes.every((value, index) => value === expected[index])
      ? null
      : { kind: "error", code: "vault_not_found" };
  }
  const created = await objects.create(key, expected);
  if (created.kind === "confirmed") return null;
  if (created.kind === "throttled")
    return {
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs: created.retryAfterEpochMs,
    };
  return {
    kind: "error",
    code: "effect_unknown",
    ...("retryAfterEpochMs" in created &&
    created.retryAfterEpochMs !== undefined
      ? { retryAfterEpochMs: created.retryAfterEpochMs }
      : {}),
  };
}

/** Experimental composition root; never imported by release index.ts or its deployment configuration. */
export default {
  /** Constructs request-scoped local services without granting any inventory CPU allowance or OAuth authority.
   * @param request Experimental loopback request.
   * @param environment Explicit local-demo bindings; missing configuration remains unarmed.
   * @returns Bounded sanitized HTTP outcome, never production activation.
   */
  async fetch(
    request: Request,
    environment: SyncDemoEnvironment,
  ): Promise<Response> {
    const app = createSyncDemoApp({
      configuration: environment.DEMO_CONFIGURATION,
      registry: environment.DEMO_CREDENTIAL_REGISTRY,
      digest: sha256Content,
      resolveService: (configuration) =>
        new SyncDemoService(
          createSyncR2Store(environment.DEMO_BUCKET, Date.now),
          configuration.vaultId,
          configuration.paths,
          MAX_SYNC_DEMO_CONTENT_BYTES,
          () => prepareDemoVault(environment.DEMO_BUCKET, configuration),
        ),
    });
    return app.fetch(request);
  },
};
