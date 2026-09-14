import { createWorkerApp } from "@worker/app";
import { resolveWorkerMirrorServices } from "@worker/composition";
import {
  configureWorkerLogging,
  createWorkerLogger,
} from "@worker/logging/logtape-logger";

await configureWorkerLogging();

const worker = createWorkerApp({
  logger: createWorkerLogger(),
  resolveMirrorServices: resolveWorkerMirrorServices,
  resolveToken: (environment) => environment.OBSIDIAN_BRIDGE_TOKEN,
});

/** Fully assembled Worker application exported to the Cloudflare runtime. */
export default worker;
