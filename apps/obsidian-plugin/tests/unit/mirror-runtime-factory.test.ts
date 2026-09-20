import {
  createDisabledMirrorState,
  createMirrorWriterId,
  MIRROR_DEVICE_STATE_V2_VERSION,
  MirrorStateOwner,
  ReconciliationV3LocalEffectRecoveryService,
} from "@obsidian-ai-bridge/core";
import { createMirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-factory";
import {
  MIRROR_DEVICE_STATE_FORMAT,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
} from "@obsidian-plugin/state/device-state-codec";
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

  it.each(["subtle", "digest"])(
    "fails closed without host crypto.%s",
    async (missing) => {
      const app = new App();
      const subtle =
        missing === "digest"
          ? new Proxy(globalThis.crypto.subtle, {
              get(target, property, receiver) {
                if (property === "digest") return undefined;
                return Reflect.get(target, property, receiver);
              },
            })
          : undefined;
      const cryptography = new Proxy(globalThis.crypto, {
        get(target, property, receiver) {
          if (property === "subtle") return subtle;
          return Reflect.get(target, property, receiver);
        },
      });
      vi.stubGlobal("crypto", cryptography);
      await expect(createMirrorRuntimeOwner(app, app.vault)).rejects.toThrow(
        "cryptography is unavailable",
      );
    },
  );

  it("rejects a non-v4 host identity", async () => {
    const app = new App();
    vi.stubGlobal("crypto", {
      randomUUID: () => "invalid",
      subtle: globalThis.crypto.subtle,
    });
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

  it("does not publish an owner or access the vault/network before migrated v4 read-back", async () => {
    const app = new App();
    const deviceId = createMirrorWriterId(
      "11111111-1111-4111-8111-111111111111",
    );
    if (deviceId === undefined) throw new Error("Invalid fixture identity.");
    const v2 = createDisabledMirrorState(deviceId);
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      JSON.stringify({
        format: MIRROR_DEVICE_STATE_FORMAT,
        version: MIRROR_DEVICE_STATE_V2_VERSION,
        deviceId: v2.deviceId,
        lifecycle: v2.lifecycle,
        globalBlockReason: v2.globalBlockReason,
        paths: v2.paths,
        stagedHandoff: v2.stagedHandoff,
      }),
    );
    const barrier = Promise.withResolvers<void>();
    host.saveLocalStorage.mockImplementationOnce(async (key, value) => {
      await barrier.promise;
      host.localStorage.set(key, value);
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let published = false;
    const pending = createMirrorRuntimeOwner(app, app.vault).then((owner) => {
      published = true;
      return owner;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(host.vault.getAbstractFileByPath).not.toHaveBeenCalled();

    barrier.resolve();
    const owner = await pending;
    expect(owner.stateOwner.snapshot().state.reconciliationReviews).toEqual([]);
    expect(owner.stateOwner.snapshot().state.reconciliationOperations).toEqual(
      [],
    );
    expect(host.saveLocalStorage).toHaveBeenCalledTimes(1);
    expect(host.loadLocalStorage).toHaveBeenCalledTimes(2);
  });

  it("does not publish runtime authority when migrated local-effect recovery cannot persist", async () => {
    const app = new App();
    const deviceId = createMirrorWriterId(
      "11111111-1111-4111-8111-111111111111",
    );
    if (deviceId === undefined) throw new Error("Invalid fixture identity.");
    const state = createDisabledMirrorState(deviceId);
    const snapshot = new MirrorStateOwner(state, {
      save: async () => ({ kind: "saved" }),
    }).snapshot();
    vi.spyOn(
      ReconciliationV3LocalEffectRecoveryService.prototype,
      "recover",
    ).mockResolvedValueOnce({ kind: "unavailable", snapshot });

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
