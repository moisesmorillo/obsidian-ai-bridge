import { AUTHENTICATION_CONFIGURATION_MODE } from "@worker/auth/auth.constants";
import { resolveWorkerAuthentication } from "@worker/index";
import { describe, expect, it } from "vitest";

describe("Worker entrypoint", () => {
  it("exports a fully assembled fetch application that fails missing auth mode closed", async () => {
    const { default: worker } = await import("@worker/index");
    expect(worker).toHaveProperty("fetch");
    const response = await Reflect.apply(worker.fetch, worker, [
      new Request("https://example.test/api/v1/notes"),
      { OBSIDIAN_BRIDGE_TOKEN: "token" },
    ]);
    expect(response.status).toBe(401);
  });

  it("selects exactly one explicit authority without mixed fallback", () => {
    const bothSecrets = {
      OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY: "registry",
      OBSIDIAN_BRIDGE_TOKEN: "singleton",
    };
    expect(
      resolveWorkerAuthentication({
        ...bothSecrets,
        OBSIDIAN_BRIDGE_AUTH_MODE:
          AUTHENTICATION_CONFIGURATION_MODE.credentialRegistry,
      }),
    ).toEqual({
      mode: AUTHENTICATION_CONFIGURATION_MODE.credentialRegistry,
      serializedRegistry: "registry",
    });
    expect(
      resolveWorkerAuthentication({
        ...bothSecrets,
        OBSIDIAN_BRIDGE_AUTH_MODE:
          AUTHENTICATION_CONFIGURATION_MODE.singletonMigration,
      }),
    ).toEqual({
      mode: AUTHENTICATION_CONFIGURATION_MODE.singletonMigration,
      token: "singleton",
    });
    expect(resolveWorkerAuthentication(bothSecrets)).toEqual({
      mode: AUTHENTICATION_CONFIGURATION_MODE.invalid,
    });
  });
});
