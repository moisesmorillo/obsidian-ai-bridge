import {
  apiErrorResponseSchema,
  healthResponseSchema,
  noteListResponseSchema,
  noteWriteResponseSchema,
  PROTOCOL_VERSION,
  protocolEnvelopeSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

describe("protocol schemas", () => {
  it("accepts the M1 response contracts", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({
      status: "ok",
    });
    expect(noteListResponseSchema.parse({ notes: ["Alpha.md"] })).toEqual({
      notes: ["Alpha.md"],
    });
    expect(
      noteWriteResponseSchema.parse({ path: "Alpha.md", stored: true }),
    ).toEqual({ path: "Alpha.md", stored: true });
    expect(
      apiErrorResponseSchema.parse({
        error: { code: "invalid_path", message: "The note path is invalid." },
      }),
    ).toEqual({
      error: { code: "invalid_path", message: "The note path is invalid." },
    });
  });

  it("validates envelopes using the current protocol version", () => {
    expect(
      protocolEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "request-1",
      }),
    ).toEqual({ protocolVersion: PROTOCOL_VERSION, requestId: "request-1" });
  });
});
