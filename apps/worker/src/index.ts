import { createWorkerApp } from "@worker/app";
import type { WorkerEnv } from "@worker/env/env.types";
import { R2VaultRepository } from "@worker/infrastructure/r2-vault.repository";
import { ConsoleLogger } from "@worker/logging/console-logger";

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const app = createWorkerApp({
      repository: new R2VaultRepository(env.VAULT_BUCKET),
      token: env.OBSIDIAN_BRIDGE_TOKEN,
      logger: new ConsoleLogger(console),
    });
    return await app.fetch(request);
  },
};

export default worker;
