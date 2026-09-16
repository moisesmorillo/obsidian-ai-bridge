import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorWriterId,
  formatApplicationEtag,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorDeviceState,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import { encodeMirrorPreferences } from "@obsidian-plugin/configuration/mirror-preferences";
import AiBridgePlugin from "@obsidian-plugin/main";
import {
  encodeMirrorDeviceState,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
} from "@obsidian-plugin/state/device-state-codec";
import {
  host,
  resetHost,
  Setting,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  addFile,
  command,
  manifest,
  modalText,
} from "@obsidian-plugin-tests/support/plugin-fixture";
import {
  App,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const PATH = required(normalizeNotePath("created.md"));
const CONTENT = "saved automatic text";

beforeEach(resetHost);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plugin automatic mirror composition", () => {
  it("registers events before layout bootstrap and mirrors a later saved create through the host timer", async () => {
    const state: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
    };
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE-BEARER");

    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        const handle = nextTimer++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: number) => timers.delete(handle),
    });
    const contentHash = await sha256(CONTENT);
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname.endsWith("/mirror")) {
          return json({
            protocol: "obsidian-ai-bridge-mirror-v2",
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            maxNoteSizeBytes: 1024 * 1024,
            maxPageSize: 50,
            recoveryRetentionSeconds: 2_592_000,
          });
        }
        if (url.pathname === "/api/v2/notes") {
          return json({ notes: [], nextCursor: null });
        }
        if (url.pathname.endsWith("/state")) {
          return json({ kind: "absent", path: PATH });
        }
        const operationId = new Headers(init.headers).get(
          "Bridge-Operation-Id",
        );
        if (init.method === "PUT" && operationId !== null) {
          return json(
            {
              path: PATH,
              revision: REVISION,
              receipt: {
                action: "create",
                associationId: ASSOCIATION_ID,
                operationId,
                precondition: { kind: "absent" },
                contentSha256: contentHash,
              },
            },
            201,
            { ETag: formatApplicationEtag(REVISION) },
          );
        }
        return json({ code: "not_found", message: "Not found" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetch);

    const plugin = new AiBridgePlugin(new App(), manifest);
    await Promise.resolve(plugin.load());
    expect(fetch).not.toHaveBeenCalled();
    expect(host.vault.getFiles).not.toHaveBeenCalled();
    expect(host.vault.on.mock.invocationCallOrder.at(-1)).toBeLessThan(
      host.onLayoutReady.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    host.becomeLayoutReady();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(host.vault.getFiles).toHaveBeenCalledOnce();

    const file = addFile(PATH, CONTENT);
    host.emitVault("create", file);
    await vi.waitFor(() => expect(timers.size).toBe(1));
    now = 1_000;
    const callback = [...timers.values()][0];
    timers.clear();
    callback?.();

    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init.method === "PUT")).toBe(
        true,
      ),
    );
    const put = fetch.mock.calls.find(([, init]) => init.method === "PUT");
    expect(put?.[1].body).toBe(CONTENT);
    expect(new Headers(put?.[1].headers).get("Authorization")).toBe(
      "Bearer PRIVATE-BEARER",
    );
    expect(JSON.stringify(host.loadData.mock.results)).not.toContain(
      "PRIVATE-BEARER",
    );
    expect([...host.localStorage.values()].join("\n")).not.toContain(CONTENT);

    await command("check-mirror-now")();
    await vi.waitFor(() =>
      expect(host.notices.at(-1)?.message).toBe("Mirror operation completed."),
    );
    plugin.unload();
  });

  it("rescans and synchronizes a create missed during a detached listener gap", async () => {
    const state: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
    };
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE-BEARER");
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        const handle = nextTimer++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: number) => timers.delete(handle),
    });
    const contentHash = await sha256(CONTENT);
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname.endsWith("/mirror")) {
          return json({
            protocol: "obsidian-ai-bridge-mirror-v2",
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            maxNoteSizeBytes: 1024 * 1024,
            maxPageSize: 50,
            recoveryRetentionSeconds: 2_592_000,
          });
        }
        if (url.pathname === "/api/v2/notes") {
          return json({ notes: [], nextCursor: null });
        }
        if (url.pathname.endsWith("/state")) {
          return json({ kind: "absent", path: PATH });
        }
        const operationId = new Headers(init.headers).get(
          "Bridge-Operation-Id",
        );
        if (init.method === "PUT" && operationId !== null) {
          return json(
            {
              path: PATH,
              revision: REVISION,
              receipt: {
                action: "create",
                associationId: ASSOCIATION_ID,
                operationId,
                precondition: { kind: "absent" },
                contentSha256: contentHash,
              },
            },
            201,
            { ETag: formatApplicationEtag(REVISION) },
          );
        }
        return json({ code: "not_found", message: "Not found" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetch);

    const app = new App();
    const first = new AiBridgePlugin(app, manifest);
    await Promise.resolve(first.load());
    host.becomeLayoutReady();
    await vi.waitFor(() => expect(host.vault.getFiles).toHaveBeenCalledOnce());
    first.unload();

    addFile(PATH, CONTENT);
    const replacement = new AiBridgePlugin(app, manifest);
    await Promise.resolve(replacement.load());
    await vi.waitFor(() =>
      expect(host.vault.getFiles).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(timers.size).toBe(1));
    now = 10_000;
    const callback = [...timers.values()][0];
    timers.clear();
    callback?.();
    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init.method === "PUT")).toBe(
        true,
      ),
    );
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
    ).toHaveLength(1);
    replacement.unload();
  });

  it("schedules positive work at admission while reporting inventory remains pending", async () => {
    const state: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
    };
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE-BEARER");
    addFile(PATH, CONTENT);

    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        const handle = nextTimer++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: number) => timers.delete(handle),
    });
    const inventory = Promise.withResolvers<Response>();
    let inventorySettled = false;
    const contentHash = await sha256(CONTENT);
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname.endsWith("/mirror")) {
          return json({
            protocol: "obsidian-ai-bridge-mirror-v2",
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            maxNoteSizeBytes: 1024 * 1024,
            maxPageSize: 50,
            recoveryRetentionSeconds: 2_592_000,
          });
        }
        if (url.pathname === "/api/v2/notes") {
          return inventory.promise;
        }
        if (url.pathname.endsWith("/state")) {
          return json({ kind: "absent", path: PATH });
        }
        const operationId = new Headers(init.headers).get(
          "Bridge-Operation-Id",
        );
        if (init.method === "PUT" && operationId !== null) {
          return json(
            {
              path: PATH,
              revision: REVISION,
              receipt: {
                action: "create",
                associationId: ASSOCIATION_ID,
                operationId,
                precondition: { kind: "absent" },
                contentSha256: contentHash,
              },
            },
            201,
            { ETag: formatApplicationEtag(REVISION) },
          );
        }
        return json({ code: "not_found", message: "Not found" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetch);

    const plugin = new AiBridgePlugin(new App(), manifest);
    await Promise.resolve(plugin.load());
    host.becomeLayoutReady();
    await vi.waitFor(() => expect(timers.size).toBe(1));
    expect(inventorySettled).toBe(false);
    now = 1_000;
    const callback = [...timers.values()][0];
    timers.clear();
    callback?.();

    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init.method === "PUT")).toBe(
        true,
      ),
    );
    expect(inventorySettled).toBe(false);
    inventory.resolve(json({ notes: [], nextCursor: null }));
    inventorySettled = true;
    await vi.waitFor(() =>
      expect(
        host.localStorage.get(MIRROR_DEVICE_STATE_STORAGE_KEY),
      ).toBeDefined(),
    );
    plugin.unload();
  });

  it("exports a quiescent metadata-only handoff through modern settings", async () => {
    const state: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
    };
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE-BEARER");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname.endsWith("/mirror")
          ? json({
              protocol: "obsidian-ai-bridge-mirror-v2",
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              maxNoteSizeBytes: 1024 * 1024,
              maxPageSize: 50,
              recoveryRetentionSeconds: 2_592_000,
            })
          : json({ notes: [], nextCursor: null }),
      ),
    );
    const plugin = new AiBridgePlugin(new App(), manifest);
    await Promise.resolve(plugin.load());
    host.becomeLayoutReady();
    await vi.waitFor(() => expect(host.vault.getFiles).toHaveBeenCalledOnce());
    const tab = [...host.settingsTabs][0];
    if (tab === undefined) throw new Error("Expected settings tab.");
    const activation = findDefinition(
      tab.settingItems,
      "Enable whole eligible Markdown mirror",
    );
    if (activation.render === undefined)
      throw new Error("Expected toggle row.");
    const row = new Setting();
    Reflect.apply(activation.render, undefined, [row, {}]);
    row.toggles[0]?.change?.(false);
    await vi.waitFor(() =>
      expect(
        findDefinition(tab.getSettingDefinitions(), "Mirror status").desc,
      ).toContain("Writer: inactive"),
    );
    row.toggles[0]?.change?.(true);
    await vi.waitFor(() =>
      expect(host.vault.getFiles).toHaveBeenCalledTimes(2),
    );
    expect(row.errorMessage).toBeNull();
    row.toggles[0]?.change?.(true);
    await vi.waitFor(() =>
      expect(row.errorMessage).toContain("Writer state was not changed"),
    );

    const handoff = findDefinition(
      tab.getSettingDefinitions(),
      "Prepare metadata-only handoff",
    );
    if (handoff.action === undefined)
      throw new Error("Expected handoff action.");
    Reflect.apply(handoff.action, undefined, [undefined, 0]);
    await vi.waitFor(() =>
      expect(modalText().join("\n")).toContain("checksum"),
    );
    expect(modalText().join("\n")).not.toContain("PRIVATE-BEARER");
    plugin.unload();
  });

  it("exports a quiescent metadata-only handoff through the operational command", async () => {
    const state: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
    };
    host.localStorage.set(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
    host.loadData.mockResolvedValue(
      encodeMirrorPreferences({
        origin: "https://bridge.example",
        loopbackHttpOrigin: null,
        secretReference: "bridge-token",
      }),
    );
    host.secrets.set("bridge-token", "PRIVATE-BEARER");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname.endsWith("/mirror")
          ? json({
              protocol: "obsidian-ai-bridge-mirror-v2",
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              maxNoteSizeBytes: 1024 * 1024,
              maxPageSize: 50,
              recoveryRetentionSeconds: 2_592_000,
            })
          : json({ notes: [], nextCursor: null }),
      ),
    );
    const plugin = new AiBridgePlugin(new App(), manifest);
    await Promise.resolve(plugin.load());
    host.becomeLayoutReady();
    await vi.waitFor(() => expect(host.vault.getFiles).toHaveBeenCalledOnce());
    await command("prepare-writer-handoff")();
    await vi.waitFor(() =>
      expect(modalText().join("\n")).toContain("checksum"),
    );
    expect(modalText().join("\n")).not.toContain("PRIVATE-BEARER");
    plugin.unload();
  });
});

function json(
  value: object,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return required(createContentSha256(encoded));
}

function findDefinition(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition {
  for (const item of items) {
    if ("name" in item && item.name === name && !("items" in item)) return item;
    if ("items" in item && Array.isArray(item.items)) {
      try {
        return findDefinition(item.items, name);
      } catch {}
    }
  }
  throw new Error(`Missing setting definition: ${name}`);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
