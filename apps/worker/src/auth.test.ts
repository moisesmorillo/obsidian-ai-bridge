import { describe, expect, it } from "vitest";
import { hasValidBearerToken } from "./auth";

function requestWithAuthorization(value?: string): Request {
  const init: RequestInit = {};
  if (value !== undefined) {
    init.headers = { Authorization: value };
  }
  return new Request("https://example.test/api/v1/notes", init);
}

describe("hasValidBearerToken", () => {
  it("accepts a valid bearer token", () => {
    expect(
      hasValidBearerToken(
        requestWithAuthorization("Bearer secret-token"),
        "secret-token",
      ),
    ).toBe(true);
  });

  it("rejects a missing bearer token", () => {
    expect(
      hasValidBearerToken(requestWithAuthorization(), "secret-token"),
    ).toBe(false);
  });

  it("rejects an invalid bearer token", () => {
    expect(
      hasValidBearerToken(
        requestWithAuthorization("Bearer wrong-token"),
        "secret-token",
      ),
    ).toBe(false);
  });
});
