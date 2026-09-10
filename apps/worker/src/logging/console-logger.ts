import type { Logger, RequestLogEntry } from "@worker/logging/logger.types";

/** Cloudflare console adapter for structured events emitted by the Worker. */
export class ConsoleLogger implements Logger {
  constructor(private readonly output: Pick<Console, "log">) {}

  info(entry: RequestLogEntry): void {
    this.output.log(JSON.stringify(entry));
  }
}
