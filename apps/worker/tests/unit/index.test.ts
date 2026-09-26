import { resolveWorkerAuthentication } from "@worker/index";
import { describe, expect, it } from "vitest";

describe("Worker entrypoint", () => {
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
      const response = await Reflect.apply(worker.fetch, worker, [request, {}]);
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
