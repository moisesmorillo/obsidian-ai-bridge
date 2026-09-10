/** Hierarchical LogTape category used by the Worker adapter. */
export const WORKER_LOG_CATEGORY = ["obsidian-ai-bridge", "worker"] as const;

/** Lowest LogTape level emitted by the Worker adapter. */
export const WORKER_LOG_LEVEL = "info" as const;

/** Route label used when Hono cannot associate a request with a route pattern. */
export const UNMATCHED_ROUTE_LABEL = "unknown";

/** Structured operations emitted by the Worker logging adapter. */
export const LOG_OPERATION = {
  httpRequest: "http_request",
} as const;
