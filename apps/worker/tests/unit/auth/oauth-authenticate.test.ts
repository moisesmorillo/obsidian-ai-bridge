import type { GrantRevocationId } from "@worker/auth/grant-revocation.types";
import {
  authenticateOAuthBearer,
  authenticateOAuthRequest,
  type OAuthAuthenticationEnvironment,
  type OAuthGrantRevocationChecker,
  type OAuthValidatedToken,
} from "@worker/auth/oauth-authenticate";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthAuthorizationServer: class {
    /**
     * @param resource - Audience requested by the production adapter.
     * @returns A synthetic grant bound to the exact requested resource.
     */
    validateToken(resource: string) {
      return Promise.resolve(grant(resource));
    }
  },
}));

const REST = "https://bridge.example.invalid/api/v2";
const MCP = "https://bridge.example.invalid/mcp";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const REVOCATION_ID = "22222222-2222-4222-8222-222222222222";

/**
 * @param audience - Resource bound to the synthetic token.
 * @param scope - Exact token scopes.
 * @returns Synthetic provider output containing one resource-bound grant.
 */
function grant(
  audience = REST,
  scope: readonly string[] = ["read"],
): OAuthValidatedToken {
  return {
    audience,
    scope,
    props: {
      principalId: PRINCIPAL_ID,
      name: "desktop-one",
      revocationId: REVOCATION_ID,
      permissions: ["read", "write"],
    },
  };
}

/**
 * @param status - Authoritative synthetic revocation status.
 * @returns In-memory revocation verdict whose calls prove admission ordering.
 */
function checker(status: "active" | "revoked" | "unavailable") {
  const checked: GrantRevocationId[] = [];
  const revocations: OAuthGrantRevocationChecker = {
    check(id) {
      checked.push(id);
      return Promise.resolve(status);
    },
  };
  return { revocations, checked };
}

describe("OAuth bearer authentication", () => {
  it("narrows stored grant permissions by token scopes", async () => {
    const { revocations, checked } = checker("active");
    const result = await authenticateOAuthBearer(
      "synthetic-token",
      REST,
      async (resource, token) => {
        expect(resource).toBe(REST);
        expect(token).toBe("synthetic-token");
        return grant(REST, ["read", "delete"]);
      },
      revocations,
    );
    expect(result).toEqual({
      kind: "authenticated",
      principal: {
        clientId: PRINCIPAL_ID,
        name: "desktop-one",
        permissions: ["read"],
      },
    });
    expect(checked).toEqual([REVOCATION_ID]);
  });

  it("rejects a token for the other protected resource before R2", async () => {
    const { revocations, checked } = checker("active");
    expect(
      await authenticateOAuthBearer(
        "synthetic-token",
        MCP,
        async () => grant(REST),
        revocations,
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(checked).toEqual([]);
  });

  it("rejects unknown tokens and malformed grant props before R2", async () => {
    const { revocations, checked } = checker("active");
    expect(
      await authenticateOAuthBearer(
        "unknown",
        REST,
        async () => null,
        revocations,
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(
      await authenticateOAuthBearer(
        "bad-props",
        REST,
        async () => ({ ...grant(), props: { principalId: "../vault" } }),
        revocations,
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(checked).toEqual([]);
  });

  it("rejects an invalid revocation ID before R2", async () => {
    const { revocations, checked } = checker("active");
    expect(
      await authenticateOAuthBearer(
        "bad-marker",
        REST,
        async () => ({
          ...grant(),
          props: {
            principalId: PRINCIPAL_ID,
            name: "desktop-one",
            revocationId: "../vault",
            permissions: ["read"],
          },
        }),
        revocations,
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(checked).toEqual([]);
  });

  it("rejects grants without a matching operation scope", async () => {
    const { revocations } = checker("active");
    expect(
      await authenticateOAuthBearer(
        "synthetic-token",
        REST,
        async () => grant(REST, ["delete"]),
        revocations,
      ),
    ).toEqual({ kind: "unauthenticated" });
  });

  it("denies revoked grants and fails closed when R2 is unavailable", async () => {
    for (const [status, kind] of [
      ["revoked", "unauthenticated"],
      ["unavailable", "unavailable"],
    ] as const) {
      const { revocations } = checker(status);
      expect(
        await authenticateOAuthBearer(
          "synthetic-token",
          REST,
          async () => grant(),
          revocations,
        ),
      ).toEqual({ kind });
    }
  });

  it("reports provider and R2 exceptions as unavailable", async () => {
    const { revocations } = checker("active");
    expect(
      await authenticateOAuthBearer(
        "synthetic-token",
        REST,
        async () => {
          throw new Error("KV unavailable");
        },
        revocations,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      await authenticateOAuthBearer(
        "synthetic-token",
        REST,
        async () => grant(),
        {
          check() {
            throw new Error("R2 unavailable");
          },
        },
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("binds production requests to the configured issuer and route", async () => {
    const environment = {
      OAUTH_ISSUER: "https://bridge.example.invalid",
      OAUTH_KV: {} as KVNamespace,
      VAULT_BUCKET: {
        head: async () => null,
        put: async () => null,
      },
    } satisfies OAuthAuthenticationEnvironment;
    const headers = new Headers({ Authorization: "Bearer synthetic-token" });
    expect(
      await authenticateOAuthRequest(headers, environment, "/mcp"),
    ).toEqual({
      kind: "authenticated",
      principal: {
        clientId: PRINCIPAL_ID,
        name: "desktop-one",
        permissions: ["read"],
      },
    });
    expect(
      await authenticateOAuthRequest(
        headers,
        { ...environment, OAUTH_ISSUER: "http://bridge.example.invalid" },
        "/mcp",
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(await authenticateOAuthRequest(headers, undefined, "/mcp")).toEqual({
      kind: "unauthenticated",
    });
    expect(
      await authenticateOAuthRequest(new Headers(), environment, "/mcp"),
    ).toEqual({ kind: "unauthenticated" });
  });
});
