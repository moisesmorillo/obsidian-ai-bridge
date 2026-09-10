/** Structured request event emitted after every Worker response. */
export interface RequestLogEntry {
  readonly operation: "http_request";
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}

/** Injectable output port for non-sensitive structured events. */
export interface Logger {
  info(entry: RequestLogEntry): void;
}
