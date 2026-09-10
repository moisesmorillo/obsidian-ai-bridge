import {
  configure,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
} from "@logtape/logtape";
import type { Logger, RequestLogEntry } from "@worker/logging/logger.types";

const WORKER_LOG_CATEGORY = ["obsidian-ai-bridge", "worker"];

/** Configures LogTape's JSON sink once during Cloudflare isolate initialization. */
export function configureWorkerLogging(): Promise<void> {
  return configure({
    sinks: {
      console: getConsoleSink({ formatter: getJsonLinesFormatter() }),
    },
    loggers: [
      {
        category: WORKER_LOG_CATEGORY,
        lowestLevel: "info",
        sinks: ["console"],
      },
    ],
  });
}

/** Creates the project logging port backed by the configured LogTape category. */
export function createWorkerLogger(): Logger {
  const logger = getLogger(WORKER_LOG_CATEGORY);

  return {
    info(entry: RequestLogEntry): void {
      logger.info("HTTP request completed.", { properties: entry });
    },
  };
}
