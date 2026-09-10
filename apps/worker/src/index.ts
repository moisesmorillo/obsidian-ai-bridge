import { VaultNoteService } from "@obsidian-ai-bridge/core";
import { createWorkerApp } from "@worker/app";
import { R2VaultRepository } from "@worker/infrastructure/r2-vault.repository";
import {
  configureWorkerLogging,
  createWorkerLogger,
} from "@worker/logging/logtape-logger";

await configureWorkerLogging();

const worker = createWorkerApp({
  logger: createWorkerLogger(),
  resolveNoteService: (environment) =>
    new VaultNoteService(new R2VaultRepository(environment.VAULT_BUCKET)),
  resolveToken: (environment) => environment.OBSIDIAN_BRIDGE_TOKEN,
});

export default worker;
