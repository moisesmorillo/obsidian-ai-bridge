import { createMirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-factory";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

beforeEach(resetHost);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createMirrorRuntimeOwner", () => {
  it("fails closed without host cryptography", async () => {
    const app = new App();
    vi.stubGlobal("crypto", undefined);
    await expect(createMirrorRuntimeOwner(app, app.vault)).rejects.toThrow(
      "cryptography is unavailable",
    );
  });

  it("rejects a non-v4 host identity", async () => {
    const app = new App();
    vi.stubGlobal(
      "crypto",
      new Proxy(globalThis.crypto, {
        get(target, property, receiver) {
          if (property === "randomUUID") return () => "invalid";
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    await expect(createMirrorRuntimeOwner(app, app.vault)).rejects.toThrow(
      "identity is unavailable",
    );
  });

  it("does not publish newly provisioned state when App-local persistence fails", async () => {
    const app = new App();
    host.saveLocalStorage.mockImplementationOnce(() => {
      throw new Error("expected");
    });
    await expect(createMirrorRuntimeOwner(app, app.vault)).rejects.toThrow(
      "state is unavailable",
    );
  });

  it("does not replace corrupt App-local state", async () => {
    const app = new App();
    host.loadLocalStorage.mockReturnValueOnce({ schemaVersion: 99 });
    await expect(createMirrorRuntimeOwner(app, app.vault)).rejects.toThrow(
      "state is unavailable",
    );
    expect(host.saveLocalStorage).not.toHaveBeenCalled();
  });
});
