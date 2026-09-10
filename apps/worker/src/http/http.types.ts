import type { ApiErrorCode } from "@obsidian-ai-bridge/protocol";

/** HTTP status codes used by the M1 transport. */
export type HttpStatus = 200 | 201 | 204 | 400 | 401 | 404 | 413 | 415 | 500;

/** Explicit transport mapping for a stable protocol error code. */
export interface ApiErrorDefinition {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: HttpStatus;
}
