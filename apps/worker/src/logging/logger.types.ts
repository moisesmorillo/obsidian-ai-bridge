import type { LOG_OPERATION } from "@worker/logging/logging.constants";

/** Structured request event emitted after every Worker response. */
export interface RequestLogEntry {
  /** Fixed operation kind for completed HTTP requests. */
  readonly operation: typeof LOG_OPERATION.httpRequest;

  /** HTTP method received at the transport boundary. */
  readonly method: string;

  /** Registered route template, never a concrete note identifier. */
  readonly route: string;

  /** HTTP status returned to the caller. */
  readonly status: number;

  /** Elapsed request time in milliseconds. */
  readonly durationMs: number;
}

/** Injectable output port for non-sensitive structured events. */
export interface Logger {
  /**
   * Emits one sanitized structured request event.
   *
   * @param entry - Request metadata that excludes credentials, content, and decoded paths.
   */
  info(entry: RequestLogEntry): void;
}
