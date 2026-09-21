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

/** Closed request-authentication outcomes exposed only as sanitized diagnostics. */
export const LOG_AUTHENTICATION_RESULT = {
  authenticated: "authenticated",
  public: "public",
  rejected: "rejected",
} as const;

/** Closed route-semantic categories used for content-free request diagnostics. */
export const LOG_OPERATION_CATEGORY = {
  currentMutation: "current_mutation",
  currentRead: "current_read",
  destructiveMutation: "destructive_mutation",
  mirrorRead: "mirror_read",
  public: "public",
  recoveryMaintenance: "recovery_maintenance",
  recoveryRead: "recovery_read",
  unknown: "unknown",
} as const;
