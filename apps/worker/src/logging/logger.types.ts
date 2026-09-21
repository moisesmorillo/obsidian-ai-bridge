import type { ApiErrorCode } from "@obsidian-ai-bridge/protocol";
import type {
  LOG_AUTHENTICATION_RESULT,
  LOG_OPERATION,
  LOG_OPERATION_CATEGORY,
} from "@worker/logging/logging.constants";

/** Closed route-semantic category emitted for one completed request. */
export type LogOperationCategory =
  (typeof LOG_OPERATION_CATEGORY)[keyof typeof LOG_OPERATION_CATEGORY];

/** Common content-free fields recorded for every completed Worker request. */
interface RequestLogEntryBase {
  /** Fixed operation kind for completed HTTP requests. */
  readonly operation: typeof LOG_OPERATION.httpRequest;

  /** Closed route semantic derived from registered transport policy. */
  readonly operationCategory: LogOperationCategory;

  /** HTTP method received at the transport boundary. */
  readonly method: string;

  /** Registered route template, never a concrete note identifier. */
  readonly route: string;

  /** HTTP status returned to the caller. */
  readonly status: number;

  /** Stable sanitized API error code when the response carries one. */
  readonly errorCode?: ApiErrorCode;

  /** Elapsed request time in milliseconds. */
  readonly durationMs: number;
}

/** Authentication attribution that never includes token, digest, or display name. */
export type RequestAuthenticationAttribution =
  | {
      readonly authentication: typeof LOG_AUTHENTICATION_RESULT.authenticated;
      readonly clientId: string;
    }
  | {
      readonly authentication:
        | typeof LOG_AUTHENTICATION_RESULT.public
        | typeof LOG_AUTHENTICATION_RESULT.rejected;
      readonly clientId?: never;
    };

/** Structured content-free diagnostic event emitted after every Worker response. */
export type RequestLogEntry = RequestLogEntryBase &
  RequestAuthenticationAttribution;

/** Injectable output port for non-sensitive structured events. */
export interface Logger {
  /**
   * Emits one sanitized structured request event.
   *
   * @param entry - Request metadata that excludes credentials, content, and concrete paths.
   */
  info(entry: RequestLogEntry): void;
}
