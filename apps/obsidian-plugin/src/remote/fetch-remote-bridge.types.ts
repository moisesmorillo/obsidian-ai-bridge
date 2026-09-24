import type { RemoteRequestAdmission } from "@obsidian-ai-bridge/core";
import type { ObsidianSecretStorageHost } from "@obsidian-plugin/configuration/obsidian-secret-store";
import type { MirrorEffectDispatchAuthority } from "@obsidian-plugin/runtime/mirror-effect-dispatch-authority";
import type { MirrorRequestCancellation } from "@obsidian-plugin/runtime/mirror-request-gate";

/** Standards Fetch seam retained only at the plugin transport boundary. */
export type RemoteFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** Construction dependencies for the v2 Fetch RemoteBridge adapter. */
export interface FetchRemoteBridgeDependencies {
  /** Slice 3 validated canonical origin; the adapter never reparses endpoint policy. */
  readonly origin: string;
  /** Native SecretStorage host; bearer text is read immediately before Fetch. */
  readonly secretStorage: ObsidianSecretStorageHost;
  /** Validated native-secret reference, never a plaintext bearer. */
  readonly secretReference: string;
  /** Coordinator-owned global request admission capability. */
  readonly admission: RemoteRequestAdmission;
  /** Coordinator-owned cancellation registration retained through real settlement. */
  readonly cancellation?: MirrorRequestCancellation;
  /** Current observation lease checked at every Fetch mutation boundary. */
  readonly effectDispatchAuthority?: MirrorEffectDispatchAuthority;
  /** Injectable standards Fetch seam for deterministic transport tests. */
  readonly fetch?: RemoteFetch | null;
  /** Injectable Web Crypto implementation for exact content-receipt validation. */
  readonly crypto?: Crypto | null;
  /** Inclusive full-operation deadline, including response-body streaming. */
  readonly deadlineMilliseconds?: number;
}
