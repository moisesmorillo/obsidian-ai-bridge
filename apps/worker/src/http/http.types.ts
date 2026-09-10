import type { ApiErrorCode } from "@obsidian-ai-bridge/protocol";

/** HTTP status codes used by the M1 transport. */
export type HttpStatus = 200 | 201 | 204 | 400 | 401 | 404 | 413 | 415 | 500;

/**
 * Explicit transport mapping for a stable protocol error code.
 *
 * The protocol owns `code`; the Worker adds its public message and HTTP status.
 */
export interface ApiErrorDefinition {
  /** Protocol-stable error code exposed in the response envelope. */
  readonly code: ApiErrorCode;

  /** Sanitized user-facing message for the error envelope. */
  readonly message: string;

  /** HTTP status selected for this error. */
  readonly status: HttpStatus;
}
