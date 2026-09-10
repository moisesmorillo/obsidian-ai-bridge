import type { ApiErrorCode } from "@obsidian-ai-bridge/protocol";
import type { HTTP_STATUS } from "@worker/http/http.constants";

/** HTTP status codes used by the M1 transport. */
export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

/** Successful M1 statuses that serialize a JSON response body. */
export type SuccessfulJsonStatus =
  | (typeof HTTP_STATUS)["ok"]
  | (typeof HTTP_STATUS)["created"];

/** HTTP statuses used for public M1 API error envelopes. */
export type ApiErrorStatus = Exclude<
  HttpStatus,
  SuccessfulJsonStatus | (typeof HTTP_STATUS)["noContent"]
>;

/** API error statuses returned by handlers before the application error boundary. */
export type ClientErrorStatus = Exclude<
  ApiErrorStatus,
  (typeof HTTP_STATUS)["internalServerError"]
>;

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

  /** HTTP error status selected for this error. */
  readonly status: ApiErrorStatus;
}
