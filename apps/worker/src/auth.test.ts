import { authenticateRequest } from "@worker/auth/authenticate-request";
import { parseBearerHeader } from "@worker/auth/bearer-header";
import { hasMatchingToken } from "@worker/auth/token-comparison";
import { describe, expect, it } from "vitest";

function headersWithAuthorization(value?: string): Headers {
  const headers = new Headers();
  if (value !== undefined) {
    headers.set("Authorization", value);
  }
  return headers;
}

describe("parseBearerHeader", () => {
  it("parses a case-insensitive bearer scheme", () => {
    expect(parseBearerHeader("bearer secret-token")).toEqual({
      kind: "bearer",
      token: "secret-token",
    });
  });

  it.each([
    [null, "missing"],
    ["Bearer", "malformed"],
    ["Basic secret-token", "unsupported_scheme"],
    ["Bearer one two", "malformed"],
  ] as const)("classifies %s headers", (header, kind) => {
    expect(parseBearerHeader(header)).toMatchObject({ kind });
  });
});

describe("hasMatchingToken", () => {
  it("accepts equal tokens and rejects distinct tokens", async () => {
    await expect(
      hasMatchingToken("secret-token", "secret-token"),
    ).resolves.toBe(true);
    await expect(hasMatchingToken("wrong-token", "secret-token")).resolves.toBe(
      false,
    );
  });
});

describe("authenticateRequest", () => {
  it("authenticates only a valid bearer credential", async () => {
    await expect(
      authenticateRequest(
        headersWithAuthorization("Bearer secret-token"),
        "secret-token",
      ),
    ).resolves.toEqual({ kind: "authenticated" });
    await expect(
      authenticateRequest(headersWithAuthorization(), "secret-token"),
    ).resolves.toEqual({ kind: "unauthenticated" });
    await expect(
      authenticateRequest(
        headersWithAuthorization("Basic secret-token"),
        "secret-token",
      ),
    ).resolves.toEqual({ kind: "unauthenticated" });
  });
});
