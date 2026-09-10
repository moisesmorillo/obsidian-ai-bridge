import {
  configure,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
} from "@logtape/logtape";
import type { Logger, RequestLogEntry } from "@worker/logging/logger.types";
import {
  WORKER_LOG_CATEGORY,
  WORKER_LOG_LEVEL,
} from "@worker/logging/logging.constants";

/**
 * Configures LogTape's JSON sink once during Cloudflare isolate initialization.
 *
 * @returns A promise that settles after the Worker logging configuration is installed.
 */
export function configureWorkerLogging(): Promise<void> {
  return configure({
    sinks: {
      console: getConsoleSink({ formatter: getJsonLinesFormatter() }),
    },
    loggers: [
      {
        category: [...WORKER_LOG_CATEGORY],
        lowestLevel: WORKER_LOG_LEVEL,
        sinks: ["console"],
      },
    ],
  });
}

/**
 * Creates the project logging port backed by the configured LogTape category.
 *
 * @returns A thin logger adapter that emits structured request metadata.
 */
export function createWorkerLogger(): Logger {
  const logger = getLogger([...WORKER_LOG_CATEGORY]);

  return {
    info(entry: RequestLogEntry): void {
      logger.info("HTTP request completed.", { ...entry });
    },
  };
}
