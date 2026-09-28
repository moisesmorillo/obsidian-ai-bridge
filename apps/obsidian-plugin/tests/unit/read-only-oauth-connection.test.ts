import type { MirrorOrigin } from "@obsidian-ai-bridge/core";
import {
  formatOAuthInstallationName,
  OAUTH_CALLBACK_URI,
  ReadOnlyOAuthConnection,
  type ReadOnlyOAuthHost,
} from "@obsidian-plugin/auth/read-only-oauth-connection";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://bridge.example" as MirrorOrigin;
const RESOURCE = `${ORIGIN}/api/v2`;

function fixture(tokenOverrides: Record<string, unknown> = {}) {
  const requests: Array<{ url: string; body: string; contentType: string }> =
    [];
  const openBrowser = vi.fn();
  const saveTokens = vi.fn(async () => true);
  const saveConnection = vi.fn(async () => true);
  const verifyRead = vi.fn(async () => true);
  const host: ReadOnlyOAuthHost = {
    installationName: "Mac",
    request: async (url, body, contentType) => {
      requests.push({ url, body, contentType });
      return url.endsWith("/oauth/register")
        ? { status: 201, text: JSON.stringify({ client_id: "client-1" }) }
        : {
            status: 200,
            text: JSON.stringify({
              access_token: "access-secret",
              refresh_token: "refresh-secret",
              token_type: "bearer",
              expires_in: 3600,
              scope: "read",
              resource: RESOURCE,
              ...tokenOverrides,
            }),
          };
    },
    openBrowser,
    saveTokens,
    saveConnection,
    verifyRead,
  };
  return {
    host,
    requests,
    openBrowser,
    saveTokens,
    saveConnection,
    verifyRead,
  };
}

async function start(fixtureValue: ReturnType<typeof fixture>) {
  const connection = new ReadOnlyOAuthConnection(fixtureValue.host);
  expect(await connection.start(ORIGIN)).toEqual({ kind: "started" });
  const authorization = new URL(fixtureValue.openBrowser.mock.calls[0]?.[0]);
  return { connection, authorization };
}

describe("read-only OAuth connection", () => {
  it("uses a recognizable platform label without exposing the device ID", () => {
    const platform = {
      isIosApp: false,
      isAndroidApp: false,
      isTablet: false,
      isMacOS: false,
      isWin: false,
      isLinux: false,
    };
    expect(formatOAuthInstallationName({ ...platform, isMacOS: true })).toBe(
      "Mac",
    );
    expect(
      formatOAuthInstallationName({
        ...platform,
        isIosApp: true,
        isTablet: true,
        isMacOS: true,
      }),
    ).toBe("iPad");
    expect(formatOAuthInstallationName({ ...platform, isIosApp: true })).toBe(
      "iPhone",
    );
    expect(
      formatOAuthInstallationName({ ...platform, isAndroidApp: true }),
    ).toBe("Android phone");
    expect(
      formatOAuthInstallationName({
        ...platform,
        isAndroidApp: true,
        isTablet: true,
      }),
    ).toBe("Android tablet");
    expect(formatOAuthInstallationName({ ...platform, isWin: true })).toBe(
      "Windows PC",
    );
    expect(formatOAuthInstallationName({ ...platform, isLinux: true })).toBe(
      "Linux PC",
    );
    expect(formatOAuthInstallationName(platform)).toBe("Device");
  });
  it("registers an untrusted native client and uses a fresh S256 challenge", async () => {
    const value = fixture();
    const { connection, authorization } = await start(value);
    expect(value.requests[0]?.url).toBe(`${ORIGIN}/oauth/register`);
    expect(JSON.parse(value.requests[0]?.body ?? "{}")).toMatchObject({
      client_name: "Mac",
      redirect_uris: [OAUTH_CALLBACK_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(authorization.origin).toBe(ORIGIN);
    expect(authorization.pathname).toBe("/authorize");
    expect(authorization.searchParams.get("scope")).toBe("read");
    expect(authorization.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      OAUTH_CALLBACK_URI,
    );
    expect(await connection.start(ORIGIN)).toEqual({ kind: "busy" });

    const result = await connection.complete({
      code: "one-use-code",
      state: authorization.searchParams.get("state") ?? "",
      iss: ORIGIN,
    });
    expect(result).toEqual({ kind: "connected" });
    const body = new URLSearchParams(value.requests[1]?.body);
    expect(body.get("code_verifier")).not.toBeNull();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.get("code_verifier") ?? ""),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
    expect(body.get("resource")).toBe(RESOURCE);
    expect(body.get("redirect_uri")).toBe(OAUTH_CALLBACK_URI);
    expect(value.saveTokens).toHaveBeenCalledWith(
      "access-secret",
      "refresh-secret",
    );
    expect(value.verifyRead).toHaveBeenCalledWith(ORIGIN, "access-secret");
    expect(value.saveConnection).toHaveBeenCalledWith(ORIGIN);
  });

  it.each([
    { state: "wrong", iss: ORIGIN, code: "code" },
    { state: "STATE", iss: "https://other.example", code: "code" },
    { state: "STATE", iss: ORIGIN, code: "" },
    { state: "STATE", iss: ORIGIN, code: "code", error: "access_denied" },
  ])(
    "consumes an invalid callback without exchanging or saving tokens",
    async (callback) => {
      const value = fixture();
      const { connection, authorization } = await start(value);
      const params = {
        ...callback,
        state:
          callback.state === "STATE"
            ? (authorization.searchParams.get("state") ?? "")
            : callback.state,
      };
      expect(await connection.complete(params)).toEqual({ kind: "failed" });
      expect(value.requests).toHaveLength(1);
      expect(value.saveTokens).not.toHaveBeenCalled();
      expect(await connection.complete(params)).toEqual({ kind: "failed" });
    },
  );

  it("rejects a token for the wrong resource or scope before native storage", async () => {
    for (const override of [
      { resource: "https://other.example/api/v2" },
      { scope: "read write" },
      { token_type: "Basic" },
    ]) {
      const value = fixture(override);
      const { connection, authorization } = await start(value);
      expect(
        await connection.complete({
          code: "code",
          state: authorization.searchParams.get("state") ?? "",
          iss: ORIGIN,
        }),
      ).toEqual({ kind: "failed" });
      expect(value.saveTokens).not.toHaveBeenCalled();
    }
  });

  it("rejects detached attempts and does not publish after native storage fails", async () => {
    const value = fixture();
    value.saveTokens.mockResolvedValue(false);
    const { connection, authorization } = await start(value);
    expect(
      await connection.complete({
        code: "code",
        state: authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });
    expect(value.saveConnection).not.toHaveBeenCalled();
    connection.detach();
    expect(await connection.start(ORIGIN)).toEqual({ kind: "busy" });
  });

  it("does not store an unverified token or continue after detach during verification", async () => {
    const unverified = fixture();
    unverified.verifyRead.mockResolvedValue(false);
    const first = await start(unverified);
    expect(
      await first.connection.complete({
        code: "code",
        state: first.authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });
    expect(unverified.saveTokens).not.toHaveBeenCalled();

    const detached = fixture();
    let finishVerification: ((value: boolean) => void) | undefined;
    detached.verifyRead.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve;
        }),
    );
    const second = await start(detached);
    const completion = second.connection.complete({
      code: "code",
      state: second.authorization.searchParams.get("state") ?? "",
      iss: ORIGIN,
    });
    await vi.waitFor(() => expect(finishVerification).toBeDefined());
    second.connection.detach();
    finishVerification?.(true);
    expect(await completion).toEqual({ kind: "failed" });
    expect(detached.saveTokens).not.toHaveBeenCalled();
  });

  it("expires an abandoned browser attempt and rejects its stale callback", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      const { connection, authorization } = await start(value);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(
        await connection.complete({
          code: "stale-code",
          state: authorization.searchParams.get("state") ?? "",
          iss: ORIGIN,
        }),
      ).toEqual({ kind: "failed" });
      expect(value.requests).toHaveLength(1);
      expect(await connection.start(ORIGIN)).toEqual({ kind: "started" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses invalid origins and malformed registration responses", async () => {
    const value = fixture();
    const connection = new ReadOnlyOAuthConnection(value.host);
    expect(
      await connection.start("http://bridge.example" as MirrorOrigin),
    ).toEqual({
      kind: "failed",
    });
    expect(await connection.start("not a URL" as MirrorOrigin)).toEqual({
      kind: "failed",
    });
    expect(value.requests).toHaveLength(0);

    value.host.request = async () => ({ status: 201, text: "not JSON" });
    expect(await connection.start(ORIGIN)).toEqual({ kind: "failed" });
    expect(value.openBrowser).not.toHaveBeenCalled();
  });

  it("drops a pending attempt when the browser cannot open", async () => {
    const value = fixture();
    value.openBrowser.mockImplementationOnce(() => {
      throw new Error("browser unavailable");
    });
    const connection = new ReadOnlyOAuthConnection(value.host);
    expect(await connection.start(ORIGIN)).toEqual({ kind: "failed" });
    expect(await connection.start(ORIGIN)).toEqual({ kind: "started" });
  });

  it("never publishes a connection when token verification or configuration fails", async () => {
    const malformed = fixture();
    malformed.host.request = async (url) =>
      url.endsWith("/oauth/register")
        ? { status: 201, text: JSON.stringify({ client_id: "client-1" }) }
        : { status: 200, text: "not JSON" };
    const first = await start(malformed);
    expect(
      await first.connection.complete({
        code: "code",
        state: first.authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });
    expect(malformed.saveTokens).not.toHaveBeenCalled();

    const oversized = fixture();
    oversized.host.request = async (url) =>
      url.endsWith("/oauth/register")
        ? { status: 201, text: JSON.stringify({ client_id: "client-1" }) }
        : { status: 200, text: "x".repeat(16 * 1024 + 1) };
    const oversizedAttempt = await start(oversized);
    expect(
      await oversizedAttempt.connection.complete({
        code: "code",
        state: oversizedAttempt.authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });
    expect(oversized.saveTokens).not.toHaveBeenCalled();

    const rejected = fixture();
    rejected.saveConnection.mockResolvedValue(false);
    const second = await start(rejected);
    expect(
      await second.connection.complete({
        code: "code",
        state: second.authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });

    const failedRead = fixture();
    failedRead.verifyRead.mockRejectedValue(new Error("network unavailable"));
    const third = await start(failedRead);
    expect(
      await third.connection.complete({
        code: "code",
        state: third.authorization.searchParams.get("state") ?? "",
        iss: ORIGIN,
      }),
    ).toEqual({ kind: "failed" });
    expect(failedRead.saveTokens).not.toHaveBeenCalled();
  });
});
