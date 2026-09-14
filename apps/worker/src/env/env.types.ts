/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare bindings required by the Worker adapter.
 *
 * The token is supplied as a Wrangler secret and is never included in API logs or responses.
 */
export interface WorkerEnv {
  /** R2 bucket containing namespaced vault note objects. */
  readonly VAULT_BUCKET: R2Bucket;

  /** Bearer token secret required by authenticated API routes. */
  readonly OBSIDIAN_BRIDGE_TOKEN: string;

  /** Non-secret UUID-v4 identifying the configured mirror namespace. */
  readonly MIRROR_ASSOCIATION_ID?: string;

  /** Non-secret UUID-v4 identifying the one designated cooperating writer. */
  readonly MIRROR_WRITER_ID?: string;
}
