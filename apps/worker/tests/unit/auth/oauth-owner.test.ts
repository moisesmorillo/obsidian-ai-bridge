import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { handleOAuthOwnerRequest } from "@worker/auth/oauth-owner";
import type { WorkerEnv } from "@worker/env/env.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  parse: vi.fn(),
  lookup: vi.fn(),
  begin: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  complete: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class extends Error {},
  CimdFetchError: class extends Error {},
  OAuthAuthorizationServer: class {
    getOAuthApi() {
      return {
        parseAuthRequest: provider.parse,
        lookupClient: provider.lookup,
        beginConsent: provider.begin,
        approveConsent: provider.approve,
        denyConsent: provider.deny,
        completeAuthorization: provider.complete,
        listUserGrants: provider.list,
        revokeGrant: provider.revoke,
      };
    }
    fetch() {
      return provider.fetch();
    }
  },
}));

const ISSUER = "https://bridge.example.test";
const REVOCATION_ID = "22222222-2222-4222-8222-222222222222";
const authRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "http://127.0.0.1:1234/callback",
  scope: ["read", "write"],
  state: "synthetic-state",
  resource: `${ISSUER}/mcp`,
};
const access = {
  aud: "synthetic-app",
  getIdentity: async () => ({ email: "Owner@Example.test" }),
};

/**
 * @param put - Synthetic private R2 marker write.
 * @returns Synthetic Worker bindings with a private revocation bucket.
 */
function environment(
  put: () => Promise<{ key: string } | null> = vi.fn(async () => ({
    key: "marker",
  })),
): WorkerEnv {
  return {
    OAUTH_ISSUER: ISSUER,
    OAUTH_KV: {} as KVNamespace,
    VAULT_BUCKET: {
      head: vi.fn(async () => null),
      put,
    } as unknown as R2Bucket,
  };
}

/**
 * @param path - Owner route.
 * @param body - URL-encoded synthetic fields.
 * @param origin - Browser Origin header.
 * @returns Browser form with an exact origin and URL-encoded body.
 */
function post(path: string, body: string, origin = ISSUER): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.parse.mockResolvedValue(authRequest);
  provider.lookup.mockResolvedValue({
    clientId: "client-1",
    clientName: "<script>alert(1)</script>",
  });
  provider.begin.mockResolvedValue({
    handle: "handle-1",
    headers: new Headers(),
  });
  provider.approve.mockResolvedValue({
    request: authRequest,
    headers: new Headers(),
  });
  provider.complete.mockResolvedValue({
    redirectTo: `${authRequest.redirectUri}?code=synthetic`,
  });
  provider.list.mockResolvedValue({ items: [], cursor: undefined });
  provider.revoke.mockResolvedValue(undefined);
  provider.fetch.mockResolvedValue(new Response("metadata"));
});

describe("owner authorization", () => {
  it("requires verified Access identity before parsing a client request", async () => {
    const response = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize?client_id=client-1`),
      environment(),
      undefined,
    );
    expect(response.status).toBe(401);
    expect(provider.parse).not.toHaveBeenCalled();
  });

  it("escapes client metadata and shows the destination, resource, and requested scopes", async () => {
    const response = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize?client_id=client-1`),
      environment(),
      access,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("<script>");
    expect(body).toContain("127.0.0.1");
    expect(body).toContain(`${ISSUER}/mcp`);
    expect(body).toContain('value="read"');
    expect(body).toContain('value="write"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' http://127.0.0.1:1234",
    );
  });

  it("allows the native Obsidian callback through the consent form CSP", async () => {
    provider.parse.mockResolvedValue({
      ...authRequest,
      redirectUri: "obsidian://ai-bridge-oauth",
    });
    const response = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize?client_id=client-1`),
      environment(),
      access,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' obsidian:",
    );
  });

  it("issues one independently revocable grant limited to selected permissions", async () => {
    const response = await handleOAuthOwnerRequest(
      post(
        "/authorize",
        "handle=handle-1&decision=approve&name=desktop-one&scope=read",
      ),
      environment(),
      access,
    );
    expect(response.status).toBe(302);
    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner@example.test",
        scope: ["read"],
        revokeExistingGrants: false,
        props: expect.objectContaining({
          name: "desktop-one",
          permissions: ["read"],
        }),
      }),
    );
  });

  it("refuses cross-origin approval and scopes beyond the client's request", async () => {
    const crossOrigin = await handleOAuthOwnerRequest(
      post(
        "/authorize",
        "handle=handle-1&decision=approve&name=desktop-one&scope=read",
        "https://evil.test",
      ),
      environment(),
      access,
    );
    const excessScope = await handleOAuthOwnerRequest(
      post(
        "/authorize",
        "handle=handle-1&decision=approve&name=desktop-one&scope=delete",
      ),
      environment(),
      access,
    );
    expect(crossOrigin.status).toBe(403);
    expect(excessScope.status).toBe(400);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("returns the provider's denial redirect without creating a grant", async () => {
    provider.deny.mockResolvedValue({
      headers: new Headers({
        Location: "http://127.0.0.1:1234/callback?error=access_denied",
      }),
    });
    const response = await handleOAuthOwnerRequest(
      post("/authorize", "handle=handle-1&decision=deny"),
      environment(),
      access,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("error=access_denied");
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, and oversized consent fields before issuance", async () => {
    const invalid = [
      "handle=handle-1&decision=approve&name=bad%2Fname&scope=read",
      "handle=handle-1&decision=approve&name=desktop-one&scope=read&scope=read",
      "handle=handle-1&decision=unknown&name=desktop-one&scope=read",
      "handle=handle-1&decision=approve&name=desktop-one&scope=read&padding=" +
        "x".repeat(9000),
    ];
    for (const body of invalid) {
      const response = await handleOAuthOwnerRequest(
        post("/authorize", body),
        environment(),
        access,
      );
      expect(response.status).toBe(400);
    }
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("lists only verified owner grants and escapes stored names and cursors", async () => {
    provider.list.mockResolvedValue({
      items: [
        {
          id: "grant-1",
          clientId: "client-1",
          userId: "owner@example.test",
          scope: ["read"],
          metadata: { name: "safe-client", revocationId: REVOCATION_ID },
          resource: `${ISSUER}/api/v2`,
          createdAt: 1,
        },
      ],
      cursor: "next&cursor",
    });
    const response = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/auth/grants?cursor=current%26cursor`),
      environment(),
      access,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(provider.list).toHaveBeenCalledWith("owner@example.test", {
      limit: 50,
      cursor: "current&cursor",
    });
    expect(body).toContain("safe-client");
    expect(body).toContain("next%26cursor");
    expect(body).toContain('value="current&#38;cursor"');
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("writes the R2 denial marker before revoking the provider grant", async () => {
    const put = vi.fn(async () => ({ key: "marker" }));
    provider.list.mockResolvedValue({
      items: [
        {
          id: "grant-1",
          clientId: "client-1",
          userId: "owner@example.test",
          scope: ["read"],
          metadata: { name: "desktop-one", revocationId: REVOCATION_ID },
          createdAt: 1,
        },
      ],
    });
    const response = await handleOAuthOwnerRequest(
      post("/auth/grants", "grantId=grant-1"),
      environment(put),
      access,
    );
    expect(response.status).toBe(303);
    expect(put).toHaveBeenCalledOnce();
    expect(provider.revoke).toHaveBeenCalledWith(
      "grant-1",
      "owner@example.test",
    );
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(
      provider.revoke.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never deletes the provider grant when the R2 deny marker is unconfirmed", async () => {
    provider.list.mockResolvedValue({
      items: [
        {
          id: "grant-1",
          clientId: "client-1",
          userId: "owner@example.test",
          scope: ["read"],
          metadata: { name: "desktop-one", revocationId: REVOCATION_ID },
          createdAt: 1,
        },
      ],
    });
    const result = await handleOAuthOwnerRequest(
      post("/auth/grants", "grantId=grant-1"),
      environment(vi.fn(async () => null)),
      access,
    );
    expect(result.status).toBe(503);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("refuses to revoke a grant absent from the owner's page or missing its R2 marker ID", async () => {
    const missing = await handleOAuthOwnerRequest(
      post("/auth/grants", "grantId=unknown"),
      environment(),
      access,
    );
    provider.list.mockResolvedValue({
      items: [
        {
          id: "grant-1",
          clientId: "client-1",
          userId: "owner@example.test",
          scope: ["read"],
          metadata: { name: "legacy" },
          createdAt: 1,
        },
      ],
    });
    const noMarkerId = await handleOAuthOwnerRequest(
      post("/auth/grants", "grantId=grant-1"),
      environment(),
      access,
    );
    expect(missing.status).toBe(404);
    expect(noMarkerId.status).toBe(503);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("fails closed when owner identity or OAuth configuration is unusable", async () => {
    const invalidAccess = {
      aud: "synthetic-app",
      getIdentity: async () => ({ email: "  " }),
    };
    const missingOwner = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/auth/grants`),
      environment(),
      invalidAccess,
    );
    const missingIssuer = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/auth/grants`),
      { ...environment(), OAUTH_ISSUER: "http://bridge.example.test" },
      access,
    );
    expect(missingOwner.status).toBe(401);
    expect(missingIssuer.status).toBe(503);
    expect(provider.list).not.toHaveBeenCalled();
  });

  it("redirects only validated OAuth errors to the registered client", async () => {
    provider.parse.mockRejectedValueOnce(
      Object.assign(
        new AuthorizationError("invalid_scope", {
          description: "Unsupported scope",
        }),
        {
          code: "invalid_scope",
          description: "Unsupported scope",
          redirectUri: authRequest.redirectUri,
          state: "safe-state",
          issuer: ISSUER,
        },
      ),
    );
    const safe = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize`),
      environment(),
      access,
    );
    provider.parse.mockRejectedValueOnce(
      Object.assign(
        new AuthorizationError("invalid_request", {
          description: "Unknown client",
        }),
        { code: "invalid_request", description: "Unknown client" },
      ),
    );
    const untrusted = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize`),
      environment(),
      access,
    );
    expect(safe.status).toBe(302);
    expect(safe.headers.get("Location")).toContain("error=invalid_scope");
    expect(safe.headers.get("Location")).toContain("state=safe-state");
    expect(untrusted.status).toBe(400);
    expect(untrusted.headers.get("Location")).toBeNull();
  });

  it("returns a local refusal for client metadata failure and storage outage", async () => {
    provider.parse.mockRejectedValueOnce(
      new CimdFetchError(
        "https://client.example.test/metadata",
        new Error("unreachable"),
      ),
    );
    const metadataFailure = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize`),
      environment(),
      access,
    );
    provider.list.mockRejectedValueOnce(new Error("KV unavailable"));
    const storageFailure = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/auth/grants`),
      environment(),
      access,
    );
    expect(metadataFailure.status).toBe(400);
    expect(storageFailure.status).toBe(503);
    expect(await storageFailure.text()).not.toContain("KV");
  });

  it("rejects an unknown registered client and a consent form without its handle", async () => {
    provider.lookup.mockResolvedValueOnce(null);
    const unknownClient = await handleOAuthOwnerRequest(
      new Request(`${ISSUER}/authorize`),
      environment(),
      access,
    );
    const missingHandle = await handleOAuthOwnerRequest(
      post("/authorize", "decision=approve&name=desktop-one&scope=read"),
      environment(),
      access,
    );
    expect(unknownClient.status).toBe(400);
    expect(missingHandle.status).toBe(400);
    expect(provider.begin).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("dispatches only declared OAuth protocol routes through the Worker", async () => {
    const { default: worker } = await import("@worker/index");
    const result = await Reflect.apply(worker.fetch.bind(worker), worker, [
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      environment(),
      {},
    ]);
    const noIssuer = await Reflect.apply(worker.fetch.bind(worker), worker, [
      new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
      { ...environment(), OAUTH_ISSUER: undefined },
      {},
    ]);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("metadata");
    expect(noIssuer.status).toBe(503);
    expect(provider.fetch).toHaveBeenCalledOnce();
  });
});
