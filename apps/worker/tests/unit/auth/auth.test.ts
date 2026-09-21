import { MIRROR_HTTP_HEADER } from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_PARSE_RESULT_KIND,
  BEARER_CREDENTIALS_RESULT_KIND,
  CLIENT_PERMISSION,
} from "@worker/auth/auth.constants";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import { hasMatchingToken } from "@worker/auth/token-comparison";
import { describe, expect, it } from "vitest";

function headersWithAuthorization(value?: string): Headers {
  const headers = new Headers();
  if (value !== undefined) {
    headers.set(MIRROR_HTTP_HEADER.authorization, value);
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
  it("resolves exact registry principal metadata and sanitizes authentication failures", async () => {
    const token = "registry-token";
    const configuration = {
      serializedRegistry: serializeCredentialRegistry({
        version: 1,
        credentials: [
          {
            clientId: "11111111-1111-4111-8111-111111111111",
            name: "Read client",
            permissions: [CLIENT_PERMISSION.read],
            tokenDigest: await digestCredentialToken(token),
          },
        ],
      }),
    } as const;

    await expect(
      authenticateRequest(
        headersWithAuthorization(`Bearer ${token}`),
        configuration,
      ),
    ).resolves.toEqual({
      kind: AUTHENTICATION_RESULT_KIND.authenticated,
      principal: {
        clientId: "11111111-1111-4111-8111-111111111111",
        name: "Read client",
        permissions: [CLIENT_PERMISSION.read],
      },
    });
    for (const authorization of [
      undefined,
      "Bearer wrong-token",
      "Bearer",
      "Basic registry-token",
    ]) {
      await expect(
        authenticateRequest(
          headersWithAuthorization(authorization),
          configuration,
        ),
      ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
    }
  });

  it("rejects the retired singleton bearer even when legacy-looking input remains", async () => {
    const legacyLookingConfiguration = {
      serializedRegistry: undefined,
      mode: "singleton-migration",
      token: "old-singleton",
    };

    await expect(
      authenticateRequest(
        headersWithAuthorization("Bearer old-singleton"),
        legacyLookingConfiguration,
      ),
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
  });

  it("fails malformed or missing confidential registry configuration closed", async () => {
    await expect(
      authenticateRequest(headersWithAuthorization("Bearer supplied"), {
        serializedRegistry: "{malformed",
      }),
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
    await expect(
      authenticateRequest(headersWithAuthorization("Bearer supplied"), {
        serializedRegistry: undefined,
      }),
    ).resolves.toEqual({ kind: AUTHENTICATION_RESULT_KIND.unauthenticated });
  });
});
