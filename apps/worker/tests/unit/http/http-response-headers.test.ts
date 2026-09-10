import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import {
  createApiErrorResponseHeaders,
  createJsonResponseHeaders,
  createNoteContentResponseHeaders,
} from "@worker/http/http-response-headers";
import { describe, expect, it } from "vitest";

describe("HTTP response headers", () => {
  it("applies the shared no-store JSON policy", () => {
    expect(createJsonResponseHeaders()).toEqual({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
  });

  it("adds the bearer challenge only to unauthorized errors", () => {
    expect(createApiErrorResponseHeaders(API_ERROR_CODE.unauthorized)).toEqual({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": "Bearer",
    });
    expect(createApiErrorResponseHeaders(API_ERROR_CODE.notFound)).toEqual(
      createJsonResponseHeaders(),
    );
  });

  it("applies the shared no-store Markdown policy", () => {
    expect(createNoteContentResponseHeaders()).toEqual({
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
    });
  });
});
