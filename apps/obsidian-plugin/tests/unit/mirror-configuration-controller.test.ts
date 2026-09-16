import { MirrorConfigurationController } from "@obsidian-plugin/configuration/mirror-configuration-controller";
import {
  type MirrorPreferences,
  ObsidianPluginDataStore,
} from "@obsidian-plugin/configuration/mirror-preferences";
import AiBridgePlugin from "@obsidian-plugin/main";
import { MirrorPluginSession } from "@obsidian-plugin/runtime/mirror-plugin-session";
import { createMirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-factory";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { manifest } from "@obsidian-plugin-tests/support/plugin-fixture";
import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

const preferences: MirrorPreferences = {
  origin: "https://bridge.example",
  loopbackHttpOrigin: null,
  secretReference: "bridge-token",
};

beforeEach(resetHost);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MirrorConfigurationController settlement", () => {
  it("suppresses initial, external, and save settlements after detach", async () => {
    const app = new App();
    const plugin = new AiBridgePlugin(app, manifest);
    const owner = await createMirrorRuntimeOwner(app, app.vault);
    const controller = new MirrorConfigurationController(
      new ObsidianPluginDataStore(plugin),
      owner,
    );
    expect(controller.isInvalid()).toBe(false);
    controller.detach();
    await controller.initialize({ kind: "missing" });
    await controller.reloadExternal();
    await expect(controller.save(preferences)).resolves.toBe(false);
    expect(owner.status().configuration).toBe("unconfigured");
    const session = await MirrorPluginSession.create(plugin);
    expect(session).not.toBeNull();
    session?.detach();
    vi.stubGlobal("crypto", undefined);
    await expect(
      MirrorPluginSession.create(new AiBridgePlugin(app, manifest)),
    ).resolves.toBeNull();
  });

  it("does not apply a save that detached while host persistence was pending", async () => {
    const pending = Promise.withResolvers<void>();
    host.saveData.mockReturnValueOnce(pending.promise);
    const app = new App();
    const plugin = new AiBridgePlugin(app, manifest);
    const owner = await createMirrorRuntimeOwner(app, app.vault);
    const controller = new MirrorConfigurationController(
      new ObsidianPluginDataStore(plugin),
      owner,
    );
    await controller.initialize();
    const saving = controller.save(preferences);
    controller.detach();
    pending.resolve();
    await expect(saving).resolves.toBe(false);
    expect(owner.status().configuration).toBe("unconfigured");
  });
});
