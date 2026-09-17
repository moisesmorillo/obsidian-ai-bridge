import type {
  apiErrorResponseSchema,
  healthResponseSchema,
  noteListResponseSchema,
  noteWriteResponseSchema,
  protocolEnvelopeSchema,
} from "@protocol/api.schemas";
import type { z } from "zod";

/** Stable API error-code union shared by transports and clients. */
export type ApiErrorCode = z.infer<
  typeof apiErrorResponseSchema
>["error"]["code"];

/** Shared sanitized error envelope used by retained v1 and conditional v2 HTTP routes. */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Health endpoint response. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Note listing response. */
export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

/** Historical v1 write-success DTO; retired mutation routes no longer emit it. */
export type NoteWriteResponse = z.infer<typeof noteWriteResponseSchema>;

/** Metadata envelope reserved for future protocol messages. */
export type ProtocolEnvelope = z.infer<typeof protocolEnvelopeSchema>;
