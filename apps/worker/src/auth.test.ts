import { authenticateRequest } from "@worker/auth/authenticate-request";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import { hasMatchingToken } from "@worker/auth/token-comparison";
import { describe, expect, it } from "vitest";

function headersWithAuthorization(value?: string): Headers {
  const headers = new Headers();
  if (value !== undefined) {
    headers.set("Authorization", value);
  }
  return headers;
}

describe("parseAuthorizationHeader", () => {
  it("parses generic scheme and credentials", () => {
    expect(parseAuthorizationHeader("bearer secret-token")).toEqual({
      kind: "credentials",
      scheme: "bearer",
      credentials: "secret-token",
    });
  });

  it.each([
    [null, "missing"],
    ["Bearer", "malformed"],
    ["Bearer one two", "malformed"],
  ] as const)("classifies %s headers", (header, kind) => {
    expect(parseAuthorizationHeader(header)).toMatchObject({ kind });
  });
});

describe("parseBearerCredentials", () => {
  it("accepts Bearer credentials and rejects another scheme", () => {
    expect(
      parseBearerCredentials(parseAuthorizationHeader("bearer secret-token")),
    ).toEqual({
      kind: "bearer",
      token: "secret-token",
    });
    expect(
      parseBearerCredentials(parseAuthorizationHeader("Basic secret-token")),
    ).toEqual({ kind: "unsupported_scheme" });
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
