/// <reference types="@cloudflare/workers-types" />

/** Confidential binding for the sole registry authentication authority. */
export interface WorkerAuthenticationEnvironment {
  /** Digest-only credential registry; missing or invalid input fails authentication closed. */
  readonly OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY?: string;
}

/**
 * Cloudflare bindings required by the Worker adapter.
 *
 * Verifier material is supplied as Wrangler secrets and never enters API logs or responses.
 */
export interface WorkerEnv extends WorkerAuthenticationEnvironment {
  /** R2 bucket containing namespaced vault note objects. */
  readonly VAULT_BUCKET: R2Bucket;

  /** Non-secret UUID-v4 identifying the configured mirror namespace. */
  readonly MIRROR_ASSOCIATION_ID?: string;

  /** Non-secret UUID-v4 identifying the one designated cooperating writer. */
  readonly MIRROR_WRITER_ID?: string;
}
