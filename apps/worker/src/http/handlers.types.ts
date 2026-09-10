import type { VaultRepository } from "@obsidian-ai-bridge/core";

/** Dependencies consumed by HTTP controllers, independent of Cloudflare bindings. */
export interface HandlerDependencies {
  readonly repository: VaultRepository;
}
