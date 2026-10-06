/** Explicitly experimental endpoint; it is never registered in the release Worker. */
export const SYNC_DEMO_ROUTE = "/demo/v1/request";
/** Lab transport scheme; this local-only contract never authorizes public HTTP endpoints. */
export const SYNC_DEMO_URL_PROTOCOL = "http:";
/** Accepted loopback URL hosts of the experimental wire contract, not a deployment allowlist. */
export const SYNC_DEMO_LOOPBACK_HOSTS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
] as const;
/** Official desktop plugin origin allowed by lab CORS; it confers no registry permission. */
export const SYNC_DEMO_CORS_ORIGIN = "app://obsidian.md";
/** Local lab byte admission, independent of the unchanged M7 storage limit. */
export const MAX_SYNC_DEMO_CONTENT_BYTES = 16 * 1024;
/** Metadata page ceiling required by the existing SyncStore port, not an inventory or whole-vault scan limit. */
export const MAX_SYNC_DEMO_FEED_EVENTS = 100;
/** Maximum explicitly admitted synthetic paths, independent of participant count. */
export const MAX_SYNC_DEMO_PATHS = 3;
/** Exactly two disposable vault principals and one REST principal, each with a distinct origin. */
export const SYNC_DEMO_PARTICIPANT_COUNT = 3;
/** JSON may escape each UTF-8 byte into six ASCII bytes, plus bounded request metadata. */
export const MAX_SYNC_DEMO_REQUEST_BYTES =
  6 * MAX_SYNC_DEMO_CONTENT_BYTES + 4096;
/** Closed demo operations; full mutation replay is its only operation-recovery capability. */
export const SYNC_DEMO_OPERATION = {
  current: "current",
  version: "version",
  mutate: "mutate",
  changes: "changes",
} as const;
/** Stable sanitized transport errors, separate from SyncStore domain failures. */
export const SYNC_DEMO_TRANSPORT_ERROR = {
  unavailable: "demo_unavailable",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  invalidRequest: "invalid_request",
  tooLarge: "request_too_large",
} as const;
