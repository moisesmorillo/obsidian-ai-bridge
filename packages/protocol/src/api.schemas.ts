import {
  API_ERROR_CODES,
  PROTOCOL_VERSION,
} from "@protocol/protocol.constants";
import { z } from "zod";

/** Runtime schema and OpenAPI source for a successful health response. */
export const healthResponseSchema = z.object({ status: z.literal("ok") });

/** Runtime schema and OpenAPI source for a list of normalized note paths. */
export const noteListResponseSchema = z.object({ notes: z.array(z.string()) });

/** Runtime schema and OpenAPI source for a successful note write. */
export const noteWriteResponseSchema = z.object({
  path: z.string(),
  stored: z.literal(true),
});

/** Runtime schema and OpenAPI source for every stable API error response. */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
  }),
});

/** Runtime schema for protocol envelope metadata. */
export const protocolEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
});
