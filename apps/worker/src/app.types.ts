import type { VaultRepository } from "@obsidian-ai-bridge/core";
import type { Logger } from "@worker/logging/logger.types";

/** Dependencies assembled by the Worker entrypoint and consumed by HTTP adapters. */
export interface WorkerDependencies {
  readonly repository: VaultRepository;
  readonly token?: string;
  readonly logger: Logger;
}
