import { SyncDemoService } from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_DEMO_CONTENT_BYTES,
  SYNC_DEMO_TRANSPORT_ERROR,
  SYNC_LAB_UNAVAILABLE_STATUS,
  SYNC_REMOTE_TICKET_HEADER,
} from "@obsidian-ai-bridge/protocol";
import { createSyncDemoApp } from "@worker/demo/demo-app";
import { prepareDemoVault } from "@worker/demo/index";
import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
} from "@worker/http/http.constants";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import {
  cappedRemoteBucket,
  claimRemoteTicket,
} from "@worker/remote/remote-budget";
import { decodeRemoteConfiguration } from "@worker/remote/remote-configuration";
import { sha256Content } from "@worker/storage/storage-crypto";

/** Only disposable remote resources; no release/local binding or credential fallback exists. */
interface RemoteEnvironment {
  /** Dedicated new private bucket; release and loopback bindings are not representable. */
  readonly REMOTE_BUCKET: R2ConditionalBucketPort;
  /** Strict stopped-by-default scope/HTTPS/expiry authority, supplied only after approval. */
  readonly REMOTE_CONFIGURATION?: string;
  /** Independent digest-only lab principals, never an ambient production registry. */
  readonly REMOTE_CREDENTIAL_REGISTRY?: string;
}
/** Separate HTTPS lab composition; importing/bundling this root grants no Cloudflare deployment permission. */
export default {
  /** Enforces stop/expiry and authenticated one-use admission before the capped original store; no inventory CPU grant.
   * @param request Candidate HTTPS request whose URL never selects a namespace.
   * @param environment Explicit disposable binding and separately provisioned secrets.
   * @returns Sanitized denial or typed store JSON; HTTP success alone is not a mutation ACK.
   */
  async fetch(
    request: Request,
    environment: RemoteEnvironment,
  ): Promise<Response> {
    const configuration = decodeRemoteConfiguration(
      environment.REMOTE_CONFIGURATION,
    );
    if (configuration === null)
      return Response.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.unavailable },
        {
          status: SYNC_LAB_UNAVAILABLE_STATUS,
          headers: { [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE },
        },
      );
    const bucket = cappedRemoteBucket(environment.REMOTE_BUCKET);
    return createSyncDemoApp({
      configuration: JSON.stringify({
        mode: configuration.mode,
        vaultId: configuration.vaultId,
        paths: configuration.paths,
        participants: configuration.participants,
      }),
      registry: environment.REMOTE_CREDENTIAL_REGISTRY,
      digest: sha256Content,
      remote: {
        endpoint: configuration.endpoint,
        active: () =>
          configuration.enabled &&
          Date.now() >= configuration.startsAtEpochMs &&
          Date.now() < configuration.expiresAtEpochMs,
        admit: (headers, origin) =>
          claimRemoteTicket(
            bucket,
            configuration,
            origin,
            headers.get(SYNC_REMOTE_TICKET_HEADER) ?? undefined,
          ),
      },
      resolveService: (scope) =>
        new SyncDemoService(
          createSyncR2Store(bucket, Date.now),
          scope.vaultId,
          scope.paths,
          MAX_SYNC_DEMO_CONTENT_BYTES,
          () => prepareDemoVault(bucket, scope),
        ),
    }).fetch(request);
  },
};
