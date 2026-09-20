/// <reference types="@cloudflare/workers-types" />

/** Confidential and explicit bindings used only to select request authentication authority. */
export interface WorkerAuthenticationEnvironment {
  /** Explicit authority selector; unknown or missing values fail authentication closed. */
  readonly OBSIDIAN_BRIDGE_AUTH_MODE?: string;

  /** Digest-only credential registry used by the committed authentication mode. */
  readonly OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY?: string;

  /** Legacy bearer accepted only when singleton migration mode is explicitly selected. */
  readonly OBSIDIAN_BRIDGE_TOKEN?: string;
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
