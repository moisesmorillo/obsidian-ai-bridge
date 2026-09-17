import {
  API_ERROR_CODES,
  HEALTH_STATUS,
  PROTOCOL_VERSION,
} from "@protocol/protocol.constants";
import { z } from "zod";

/** Runtime schema and OpenAPI source for a successful health response. */
export const healthResponseSchema = z
  .object({
    status: z.literal(HEALTH_STATUS.ok),
  })
  .strict();

/** Retained v1 list response shape; application path validation, not this string-array schema, guarantees normalized paths. */
export const noteListResponseSchema = z
  .object({ notes: z.array(z.string()) })
  .strict();

/** Historical v1 write-success shape retained for compatibility; current v1 mutation routes return retirement errors. */
export const noteWriteResponseSchema = z
  .object({
    path: z.string(),
    stored: z.literal(true),
  })
  .strict();

/** Runtime schema and OpenAPI source for every stable API error response. */
export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum(API_ERROR_CODES),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

/** Reserved version-0.1 envelope metadata; not the current mirror-v2 HTTP response wrapper. */
export const protocolEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
  })
  .strict();
