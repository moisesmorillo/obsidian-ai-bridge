import {
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorWriterId,
} from "@obsidian-ai-bridge/core";
import { encodeMirrorPreferences } from "@obsidian-plugin/configuration/mirror-preferences";
import {
  encodeMirrorDeviceState,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
} from "@obsidian-plugin/state/device-state-codec";
import {
  host,
  resetHost,
  Setting,
  TextElement,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { loadPluginReady } from "@obsidian-plugin-tests/support/plugin-fixture";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
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

describe("MirrorSettingsTab", () => {
  it("uses modern declarative rows for atomic endpoint consent and native secret references", async () => {
    const plugin = await loadPluginReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");

    const connection = findDefinition(tab.settingItems, "Bridge endpoint");
    if (connection.render === undefined)
      throw new Error("Expected render row.");
    const connectionRow = new Setting();
    Reflect.apply(connection.render, undefined, [connectionRow, {}]);
    connectionRow.texts[0]?.change?.("http://localhost:8787");
    connectionRow.buttons[0]?.click?.();
    expect(connectionRow.errorMessage).toContain("HTTPS origin");
    connectionRow.toggles[0]?.change?.(true);
    connectionRow.buttons[0]?.click?.();
    await vi.waitFor(() => expect(host.saveData).toHaveBeenCalledOnce());
    expect(host.saveData.mock.calls[0]?.[0]).toMatchObject({
      origin: "http://localhost:8787",
      loopbackHttpOrigin: "http://localhost:8787",
      secretReference: null,
    });

    const secret = findDefinition(
      tab.getSettingDefinitions(),
      "Bearer secret reference",
    );
    if (secret.render === undefined) throw new Error("Expected secret row.");
    Reflect.apply(secret.render, undefined, [new Setting(), {}]);
    expect(host.secretComponents.at(-1)?.value).toBe("");
    host.secretComponents.at(-1)?.change?.("bridge-token");
    await vi.waitFor(() => expect(host.saveData).toHaveBeenCalledTimes(2));
    expect(host.saveData.mock.calls[1]?.[0]).toMatchObject({
      secretReference: "bridge-token",
    });
    expect(JSON.stringify(host.saveData.mock.calls)).not.toContain(
      "bearer-value",
    );
    plugin.unload();
  });

  it("surfaces settings persistence failure without retaining a partial update", async () => {
    host.saveData.mockRejectedValueOnce(new Error("expected"));
    const plugin = await loadPluginReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const connection = findDefinition(tab.settingItems, "Bridge endpoint");
    if (connection.render === undefined)
      throw new Error("Expected render row.");
    const row = new Setting();
    Reflect.apply(connection.render, undefined, [row, {}]);
    row.texts[0]?.change?.("https://bridge.example");
    row.buttons[0]?.click?.();
    await vi.waitFor(() => expect(row.errorMessage).toContain("not be saved"));
    expect(
      findDefinition(tab.getSettingDefinitions(), "Mirror status").desc,
    ).toContain("Configuration: unconfigured");
    plugin.unload();
  });

  it("treats unavailable persisted settings as invalid configuration", async () => {
    host.loadData.mockRejectedValueOnce(new Error("expected"));
    const plugin = await loadPluginReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const status = findDefinition(tab.settingItems, "Mirror status");
    expect(status.desc).toContain("Configuration: invalid");
    plugin.unload();
  });

  it("renders copyable identity and the complete first-activation trust disclosure", async () => {
    const plugin = await loadPluginReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const identity = findDefinition(
      tab.settingItems,
      "Local device / writer ID",
    );
    if (identity.render === undefined)
      throw new Error("Expected identity row.");
    const identityRow = new Setting();
    Reflect.apply(identity.render, undefined, [identityRow, {}]);
    expect(identityRow.texts[0]?.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identityRow.texts[0]?.inputEl.readOnly).toBe(true);

    const consent = findDefinition(
      tab.settingItems,
      "Whole-mirror trust and deletion consent",
    );
    expect(consent.desc).toContain("whole eligible Markdown mirror");
    expect(consent.desc).toContain("bearer-authenticated Worker");
    expect(consent.desc).toContain("plaintext");
    expect(consent.desc).toContain("30-day recovery");
    plugin.unload();
  });

  it("verifies designation and requires consent before first activation", async () => {
    const deviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    const associationId = required(
      createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
    );
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(createDisabledMirrorState(deviceId)),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname.endsWith("/mirror")
          ? json({
              protocol: "obsidian-ai-bridge-mirror-v2",
              associationId,
              writerId: deviceId,
              maxNoteSizeBytes: 1024 * 1024,
              maxPageSize: 50,
              recoveryRetentionSeconds: 2_592_000,
            })
          : json({ notes: [], nextCursor: null }),
      ),
    );
    const plugin = await loadPluginReady();
    host.becomeLayoutReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");

    const before = new Setting();
    const activationBefore = findDefinition(
      tab.getSettingDefinitions(),
      "Enable whole eligible Markdown mirror",
    );
    if (activationBefore.render === undefined)
      throw new Error("Expected activation row.");
    Reflect.apply(activationBefore.render, undefined, [before, {}]);
    expect(before.toggles[0]?.disabled).toBe(true);

    const server = findDefinition(
      tab.getSettingDefinitions(),
      "Authenticated server identity",
    );
    if (server.action === undefined)
      throw new Error("Expected verification action.");
    Reflect.apply(server.action, undefined, [new TextElement(), 0]);
    await vi.waitFor(() =>
      expect(
        findDefinition(
          tab.getSettingDefinitions(),
          "Authenticated server identity",
        ).desc,
      ).toContain("matches this device"),
    );

    const consent = findDefinition(
      tab.getSettingDefinitions(),
      "Whole-mirror trust and deletion consent",
    );
    if (consent.render === undefined) throw new Error("Expected consent row.");
    const consentRow = new Setting();
    Reflect.apply(consent.render, undefined, [consentRow, {}]);
    consentRow.toggles[0]?.change?.(true);

    const activation = findDefinition(
      tab.getSettingDefinitions(),
      "Enable whole eligible Markdown mirror",
    );
    if (activation.render === undefined)
      throw new Error("Expected activation row.");
    const activationRow = new Setting();
    Reflect.apply(activation.render, undefined, [activationRow, {}]);
    expect(activationRow.toggles[0]?.disabled).toBe(false);
    activationRow.toggles[0]?.change?.(true);
    await vi.waitFor(() =>
      expect(JSON.stringify([...host.localStorage.values()])).toContain(
        "active",
      ),
    );
    expect(activationRow.errorMessage).toBeNull();
    expect(JSON.stringify([...host.localStorage.values()])).not.toContain(
      "PRIVATE",
    );
    plugin.unload();
  });

  it("keeps activation disabled when authenticated designation mismatches", async () => {
    const deviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    const otherWriterId = required(
      createMirrorWriterId("99999999-9999-4999-8999-999999999999"),
    );
    const associationId = required(
      createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
    );
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(createDisabledMirrorState(deviceId)),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          protocol: "obsidian-ai-bridge-mirror-v2",
          associationId,
          writerId: otherWriterId,
          maxNoteSizeBytes: 1024 * 1024,
          maxPageSize: 50,
          recoveryRetentionSeconds: 2_592_000,
        }),
      ),
    );
    const plugin = await loadPluginReady();
    host.becomeLayoutReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const server = findDefinition(
      tab.getSettingDefinitions(),
      "Authenticated server identity",
    );
    if (server.action === undefined)
      throw new Error("Expected verification action.");
    Reflect.apply(server.action, undefined, [new TextElement(), 0]);
    await vi.waitFor(() =>
      expect(
        findDefinition(
          tab.getSettingDefinitions(),
          "Authenticated server identity",
        ).desc,
      ).toContain("does not match"),
    );
    const consent = findDefinition(
      tab.getSettingDefinitions(),
      "Whole-mirror trust and deletion consent",
    );
    if (consent.render === undefined) throw new Error("Expected consent row.");
    const consentRow = new Setting();
    Reflect.apply(consent.render, undefined, [consentRow, {}]);
    consentRow.toggles[0]?.change?.(true);
    const activation = findDefinition(
      tab.getSettingDefinitions(),
      "Enable whole eligible Markdown mirror",
    );
    if (activation.render === undefined)
      throw new Error("Expected activation row.");
    const activationRow = new Setting();
    Reflect.apply(activation.render, undefined, [activationRow, {}]);
    expect(activationRow.toggles[0]?.disabled).toBe(true);
    plugin.unload();
  });

  it("keeps activation, handoff, import, and status actions thin and sanitized", async () => {
    const plugin = await loadPluginReady();
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const definitions = tab.settingItems;

    const activation = findDefinition(
      definitions,
      "Enable whole eligible Markdown mirror",
    );
    if (activation.render === undefined)
      throw new Error("Expected toggle row.");
    const activationRow = new Setting();
    Reflect.apply(activation.render, undefined, [activationRow, {}]);
    expect(activationRow.toggles[0]?.disabled).toBe(true);
    activationRow.toggles[0]?.change?.(true);
    await vi.waitFor(() =>
      expect(activationRow.errorMessage).toContain("not changed"),
    );
    activationRow.toggles[0]?.change?.(false);
    await Promise.resolve();

    const handoff = findDefinition(
      tab.getSettingDefinitions(),
      "Prepare metadata-only handoff",
    );
    if (handoff.action === undefined)
      throw new Error("Expected handoff action.");
    Reflect.apply(handoff.action, undefined, [new TextElement(), 0]);
    await vi.waitFor(() =>
      expect(host.notices.at(-1)?.message).toContain("Handoff is not ready"),
    );

    const imported = findDefinition(
      tab.getSettingDefinitions(),
      "Import metadata-only handoff",
    );
    if (imported.render === undefined) throw new Error("Expected import row.");
    const importRow = new Setting();
    Reflect.apply(imported.render, undefined, [importRow, {}]);
    importRow.textareas[0]?.change?.("{invalid}");
    importRow.buttons[0]?.click?.();
    await vi.waitFor(() =>
      expect(host.notices.at(-1)?.message).toContain("not imported"),
    );

    const status = findDefinition(tab.getSettingDefinitions(), "Mirror status");
    expect(status.desc).toContain("Configuration: unconfigured");
    plugin.unload();
  });
});

function json(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}

function findDefinition(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition {
  const found = findOptionalDefinition(items, name);
  if (found === undefined) {
    throw new Error(`Missing setting definition: ${name}`);
  }
  return found;
}

function findOptionalDefinition(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition | undefined {
  for (const item of items) {
    if ("name" in item && item.name === name && !hasItems(item)) return item;
    if (hasItems(item)) {
      const found = findOptionalDefinition(item.items, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function hasItems(item: SettingDefinitionItem): item is Extract<
  SettingDefinitionItem,
  { readonly items?: unknown }
> & {
  readonly items: SettingDefinitionItem[];
} {
  return "items" in item && Array.isArray(item.items);
}
