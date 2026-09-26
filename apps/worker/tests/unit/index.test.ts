import { resolveAccessSession } from "@worker/auth/access-session";
import { resolveWorkerAuthentication } from "@worker/index";
import { describe, expect, it } from "vitest";

describe("Worker entrypoint", () => {
  it("requires a usable Access identity on the session route without exposing it", async () => {
    const { default: worker } = await import("@worker/index");
    const access = {
      aud: "synthetic-app",
      getIdentity: async () => ({ email: "owner@example.test" }),
    };
    const sessionRequest = new Request("https://example.test/auth/session");

    const absent = await resolveAccessSession(undefined);
    const missingIdentity = await resolveAccessSession({
      aud: "synthetic-app",
      getIdentity: async () => undefined,
    });
    const failedLookup = await resolveAccessSession({
      aud: "synthetic-app",
      getIdentity: async () => {
        throw new Error("synthetic identity lookup failure");
      },
    });
    const forgedHeader = await Reflect.apply(
      worker.fetch.bind(worker),
      worker,
      [
        new Request(sessionRequest, {
          headers: { "Cf-Access-Jwt-Assertion": "unverified" },
        }),
        {},
      ],
    );
    const present = await Reflect.apply(worker.fetch.bind(worker), worker, [
      sessionRequest,
      {},
      { access },
    ]);
    const wrongMethod = await Reflect.apply(worker.fetch.bind(worker), worker, [
      new Request(sessionRequest, { method: "POST" }),
      {},
      { access },
    ]);

    expect(absent.status).toBe(401);
    expect(missingIdentity.status).toBe(401);
    expect(failedLookup.status).toBe(401);
    expect(forgedHeader.status).toBe(401);
    expect(present.status).toBe(204);
    expect(present.headers.get("Cache-Control")).toBe("no-store");
    expect(await present.text()).toBe("");
    expect(wrongMethod.status).toBe(404);
  });

  it("exports a fully assembled fetch application that fails missing registry closed", async () => {
    const { default: worker } = await import("@worker/index");
    expect(worker).toHaveProperty("fetch");
    for (const request of [
      new Request("https://example.test/api/v2/notes", {
        headers: { Authorization: "Bearer unregistered-token" },
      }),
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer unregistered-token" },
      }),
    ]) {
      const response = await Reflect.apply(worker.fetch.bind(worker), worker, [
        request,
        {},
      ]);
      expect(response.status).toBe(401);
    }
  });

  it("resolves only the digest registry and ignores retired singleton bindings", () => {
    const environment = {
      OBSIDIAN_BRIDGE_AUTH_MODE: "singleton-migration",
      OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY: "registry",
      OBSIDIAN_BRIDGE_TOKEN: "retired-token",
    };

    expect(resolveWorkerAuthentication(environment)).toEqual({
      serializedRegistry: "registry",
    });
    expect(resolveWorkerAuthentication({})).toEqual({
      serializedRegistry: undefined,
    });
  });
});
