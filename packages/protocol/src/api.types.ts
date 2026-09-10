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

/** Error envelope returned by the M1 HTTP API. */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Health endpoint response. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Note listing response. */
export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

/** Successful note write response. */
export type NoteWriteResponse = z.infer<typeof noteWriteResponseSchema>;

/** Metadata envelope reserved for future protocol messages. */
export type ProtocolEnvelope = z.infer<typeof protocolEnvelopeSchema>;
