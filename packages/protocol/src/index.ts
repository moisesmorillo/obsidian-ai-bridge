export const protocolVersion = "0.1" as const;

export interface ProtocolEnvelope {
  readonly protocolVersion: typeof protocolVersion;
  readonly requestId: string;
}

export interface HealthResponse {
  readonly status: "ok";
}

export interface NoteListResponse {
  readonly notes: readonly string[];
}

export interface NoteWriteResponse {
  readonly path: string;
  readonly stored: true;
}

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_path"
  | "unsupported_media_type"
  | "invalid_body"
  | "payload_too_large"
  | "not_found"
  | "internal_error";

export interface ApiErrorResponse {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}
