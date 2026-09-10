/// <reference types="@cloudflare/workers-types" />

/** Cloudflare bindings required by the M1 Worker adapter. */
export interface WorkerEnv {
  readonly VAULT_BUCKET: R2Bucket;
  readonly OBSIDIAN_BRIDGE_TOKEN: string;
}
