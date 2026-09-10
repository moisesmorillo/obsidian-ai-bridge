import {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_PARSE_RESULT_KIND,
  BEARER_CREDENTIALS_RESULT_KIND,
} from "@worker/auth/auth.constants";
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
      kind: AUTHORIZATION_PARSE_RESULT_KIND.credentials,
      scheme: "bearer",
      credentials: "secret-token",
    });
  });

  it.each([
    [null, AUTHORIZATION_PARSE_RESULT_KIND.missing],
    ["", AUTHORIZATION_PARSE_RESULT_KIND.malformed],
    ["   ", AUTHORIZATION_PARSE_RESULT_KIND.malformed],
    ["Bearer", AUTHORIZATION_PARSE_RESULT_KIND.malformed],
    ["Bearer one two", AUTHORIZATION_PARSE_RESULT_KIND.malformed],
  ] as const)("classifies %s headers", (header, kind) => {
    expect(parseAuthorizationHeader(header)).toMatchObject({ kind });
  });
});

describe("parseBearerCredentials", () => {
  it.each([
    ["Bearer secret-token", BEARER_CREDENTIALS_RESULT_KIND.bearer],
    ["bEaReR secret-token", BEARER_CREDENTIALS_RESULT_KIND.bearer],
  ] as const)("accepts %s", (header, kind) => {
    expect(
      parseBearerCredentials(parseAuthorizationHeader(header)),
    ).toMatchObject({ kind });
  });

  it("rejects an unsupported scheme", () => {
    expect(
      parseBearerCredentials(parseAuthorizationHeader("Basic secret-token")),
    ).toEqual({ kind: BEARER_CREDENTIALS_RESULT_KIND.unsupportedScheme });
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
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.authenticated });
    await expect(
      authenticateRequest(headersWithAuthorization(), "secret-token"),
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
    await expect(
      authenticateRequest(
        headersWithAuthorization("Basic secret-token"),
        "secret-token",
      ),
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
  });
});
