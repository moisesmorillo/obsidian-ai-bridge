import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import manifest from "@obsidian-plugin-manifest";
import * as obsidian from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  App,
  Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  TFile,
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

/** Reads generated files only; no production source entry import is involved. */
const bundle = readFileSync(
  new URL("../../dist/main.js", import.meta.url),
  "utf8",
);
const manifestText = readFileSync(
  new URL("../../dist/manifest.json", import.meta.url),
  "utf8",
);

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ASSOCIATION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION = "44444444-4444-4444-8444-444444444444";
const NOTE_PATH = "artifact/100% 雪.md";
const ENCODED_NOTE_PATH = "YXJ0aWZhY3QvMTAwJSDpm6oubWQ";
const NOTE_BODY = "ARTIFACT-FIXTURE-NOTE-BODY";
const RECOVERY_BODY = "ARTIFACT-FIXTURE-RECOVERY-BODY";
const BEARER = "ARTIFACT-FIXTURE-BEARER";
const SECRET_REFERENCE = "artifact-secret-reference";
const STATE_KEY = "ai-bridge:mirror-device-state";

interface ArtifactRealmOptions {
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly performance?: Pick<Performance, "now">;
  readonly window?: Pick<Window, "setTimeout" | "clearTimeout">;
}

/**
 * One isolated browser-like CommonJS realm retained across bundle evaluations.
 * Reusing this object models same-realm plugin replacement without importing the
 * source registry implementation into the artifact test.
 */
class ArtifactRealm {
  private readonly required: string[] = [];
  private readonly sandbox: Record<string, unknown>;
  private readonly context;

  /** @param options - Standards-only capabilities supplied to the generated bundle. */
  constructor(options: ArtifactRealmOptions = {}) {
    const timerHost =
      options.window ??
      ({
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      } satisfies Pick<Window, "setTimeout" | "clearTimeout">);
    this.sandbox = {
      AbortController,
      DOMException,
      Headers,
      ReadableStream,
      Request,
      Response,
      TextDecoder,
      TextEncoder,
      URL,
      btoa: globalThis.btoa,
      clearTimeout: timerHost.clearTimeout,
      crypto: globalThis.crypto,
      fetch: options.fetch,
      performance: options.performance ?? globalThis.performance,
      setTimeout: timerHost.setTimeout,
      window: timerHost,
      require: (name: string) => {
        expect(name).toBe("obsidian");
        this.required.push(name);
        return obsidian;
      },
    };
    this.context = createContext(this.sandbox);
  }

  /**
   * Evaluates a fresh copy of the generated bundle and awaits its host load hook.
   * @param app - Stable host identity used to test replacement ownership.
   * @returns The actual packaged plugin instance.
   */
  async load(app: App = new App()): Promise<obsidian.Plugin> {
    const module: { exports: unknown } = { exports: {} };
    this.sandbox.module = module;
    this.sandbox.exports = module.exports;
    new Script(
      `(function(module, exports, require) {\n${bundle}\n})(module, exports, require);`,
      { filename: "ai-bridge/main.js" },
    ).runInContext(this.context);
    expect(this.required.length).toBeGreaterThan(0);
    const namespace = module.exports;
    if (
      typeof namespace !== "object" ||
      namespace === null ||
      !("default" in namespace)
    ) {
      throw new Error("Expected a CommonJS default export namespace");
    }
    const pluginClass = namespace.default;
    if (
      typeof pluginClass !== "function" ||
      !(pluginClass.prototype instanceof obsidian.Plugin)
    ) {
      throw new Error("Expected the default export to extend the host Plugin");
    }
    expect(JSON.parse(manifestText)).toEqual(manifest);
    const plugin: unknown = Reflect.construct(pluginClass, [app, manifest]);
    if (!(plugin instanceof obsidian.Plugin)) {
      throw new Error("Expected a host Plugin instance");
    }
    await plugin.load();
    return plugin;
  }

  /** Installs a deliberately incompatible package registry before plugin load. */
  installIncompatibleRegistry(): void {
    new Script(
      `Object.defineProperty(globalThis, Symbol.for("obsidian-ai-bridge.runtime-mirror-coordinator"), {
        value: { format: "obsidian-ai-bridge-runtime-registry", version: 999, coordinators: new WeakMap() },
        configurable: true,
        enumerable: false,
        writable: false
      });`,
    ).runInContext(this.context);
  }
}

/**
 * @param id - Host-qualified command identity from the packaged plugin.
 * @returns The registered callback, failing immediately if packaging lost a command.
 */
function command(id: string): () => Promise<void> {
  const callback = obsidian.host.commands.get(id)?.callback;
  if (!callback) throw new Error("Expected a registered command callback");
  return async () => {
    await callback();
  };
}

/** Installs strict active-writer state/preferences without importing source codecs. */
function configureActiveWriter(): void {
  obsidian.host.localStorage.set(
    STATE_KEY,
    JSON.stringify({
      format: "obsidian-ai-bridge-device-state",
      version: 3,
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: "active",
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: null,
      reconciliationReviews: [],
      reconciliationOperations: [],
    }),
  );
  obsidian.host.loadData.mockResolvedValue({
    format: "obsidian-ai-bridge-preferences",
    version: 1,
    origin: "https://bridge.example",
    loopbackHttpOrigin: null,
    secretReference: SECRET_REFERENCE,
  });
  obsidian.host.secrets.set(SECRET_REFERENCE, BEARER);
}

/** @returns One eligible saved file in the host double. */
function addSavedNote(): TFile {
  const file = new TFile();
  file.path = NOTE_PATH;
  file.stat = {
    size: new TextEncoder().encode(NOTE_BODY).byteLength,
    mtime: 1_000,
    ctime: 1_000,
  };
  obsidian.host.files.set(file.path, file);
  obsidian.host.contents.set(file, NOTE_BODY);
  return file;
}

/**
 * @param value - Exact packaged request body to fingerprint.
 * @returns Hex SHA-256 matching the Worker's receipt contract.
 */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * @param value - JSON-compatible response payload.
 * @param status - HTTP response status.
 * @param headers - Additional operation-specific response headers.
 * @returns A typed JSON response with the API media type.
 */
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

/**
 * Finds one nested modern declarative setting by its stable label.
 * @param items - Current packaged settings definition tree.
 * @param name - Exact setting label to find.
 * @returns The matching leaf definition.
 * @throws When packaging omitted the expected definition.
 */
function findSetting(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition {
  for (const item of items) {
    if ("name" in item && item.name === name && !("items" in item)) return item;
    if ("items" in item && Array.isArray(item.items)) {
      try {
        return findSetting(item.items, name);
      } catch {}
    }
  }
  throw new Error(`Missing setting definition: ${name}`);
}

beforeEach(obsidian.resetHost);

describe("packaged Obsidian main.js", () => {
  it("stages a browser CommonJS artifact with only the intended Obsidian external and no fixture, secret, or machine leakage", () => {
    expect(manifestText).toBe(
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
    );
    expect(JSON.parse(manifestText)).toMatchObject({
      id: "ai-bridge",
      minAppVersion: "1.13.0",
      isDesktopOnly: false,
    });
    const requires = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    expect(requires.length).toBeGreaterThan(0);
    expect(new Set(requires)).toEqual(new Set(["obsidian"]));
    expect(bundle).not.toMatch(
      /\b(?:process|Buffer|Bun|__dirname|__filename)\b|node:|import\s*\(/,
    );
    expect(bundle).not.toContain(BEARER);
    expect(bundle).not.toContain("OBSIDIAN_BRIDGE_TOKEN");
    expect(bundle).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(bundle).not.toContain(NOTE_BODY);
    expect(bundle).not.toContain(RECOVERY_BODY);
    expect(bundle).not.toMatch(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:\\Users\\/,
    );
  });

  it("loads inertly, exposes modern declarative SecretStorage settings, retains both M2 commands, and cleans up official host registrations", async () => {
    const plugin = await new ArtifactRealm().load();
    expect(
      [...obsidian.host.commands].map(([id, entry]) => [id, entry.name]),
    ).toEqual([
      ["ai-bridge:inspect-local-notes", "Inspect local Markdown notes"],
      ["ai-bridge:inspect-active-note", "Inspect active Markdown note"],
      ["ai-bridge:show-mirror-status", "Show mirror status"],
      ["ai-bridge:check-mirror-now", "Check mirror now"],
      ["ai-bridge:retry-mirror-failures", "Retry mirror failures"],
      ["ai-bridge:pause-mirror", "Pause mirror"],
      ["ai-bridge:resume-mirror", "Resume mirror"],
      ["ai-bridge:prepare-writer-handoff", "Prepare writer handoff"],
    ]);
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    expect(obsidian.host.getActiveFile).not.toHaveBeenCalled();
    expect(obsidian.host.loadData).toHaveBeenCalledTimes(1);
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
    expect(obsidian.host.vaultListeners.get("create")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("modify")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("delete")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("rename")).toHaveLength(1);
    expect(obsidian.host.onLayoutReady).toHaveBeenCalledOnce();

    const settings = [...obsidian.host.settingsTabs][0];
    if (settings === undefined) throw new Error("Expected a settings tab");
    const secret = findSetting(
      settings.settingItems,
      "Bearer secret reference",
    );
    if (secret.render === undefined) {
      throw new Error("Expected a declarative SecretComponent setting");
    }
    Reflect.apply(secret.render, undefined, [
      Reflect.construct(Setting, []),
      {},
    ]);
    expect(obsidian.host.secretComponents).toHaveLength(1);
    expect(obsidian.host.getSecret).not.toHaveBeenCalled();

    const file = new TFile();
    file.path = "100% 雪.md";
    file.stat = { size: 3, mtime: 1_000, ctime: 1_000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.contents.set(file, "雪");
    obsidian.host.active = file;
    await command("ai-bridge:inspect-local-notes")();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    const [modal] = [...obsidian.host.modals];
    if (!modal) throw new Error("Expected a visible metadata modal");
    expect(
      modal.contentEl.children.map((child) => child.textContent),
    ).toContain("100% 雪.md — 3 bytes");
    await command("ai-bridge:inspect-active-note")();
    expect(obsidian.host.vault.read).toHaveBeenCalledExactlyOnceWith(file);
    expect(obsidian.host.notices.at(-1)?.message).toBe(
      "Saved note: 100% 雪.md\nUTF-8 bytes: 3\nSaved vault text only. Save and retry to include unsaved changes.",
    );

    plugin.unload();
    expect(obsidian.host.commands.size).toBe(0);
    expect(obsidian.host.settingsTabs.size).toBe(0);
    expect(obsidian.host.vaultListeners.size).toBe(4);
    expect(
      [...obsidian.host.vaultListeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
    expect(obsidian.host.modals.size).toBe(0);
    expect(modal.contentEl.children).toEqual([]);
    expect(obsidian.host.notices.every((notice) => notice.hidden)).toBe(true);
    expect(obsidian.host.contents.get(file)).toBe("雪");
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
  });

  it("turns an official saved-file event into one real v2 conditional request with canonical addressing and privileged identity", async () => {
    configureActiveWriter();
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const contentHash = await sha256(NOTE_BODY);
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname === "/api/v2/mirror") {
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
        if (url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}/state`) {
          return json({ kind: "absent", path: NOTE_PATH });
        }
        const headers = new Headers(init.headers);
        const operationId = headers.get("Bridge-Operation-Id");
        if (
          url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}` &&
          init.method === "PUT" &&
          operationId !== null
        ) {
          return json(
            {
              path: NOTE_PATH,
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
            { ETag: `"m3-${REVISION}"` },
          );
        }
        return json(
          { error: { code: "not_found", message: "Not found." } },
          404,
        );
      },
    );
    const realm = new ArtifactRealm({
      fetch,
      performance: { now: () => now },
      window: {
        setTimeout: (callback: TimerHandler) => {
          if (typeof callback !== "function") {
            throw new Error("Expected a callback timer");
          }
          const handle = nextTimer++;
          timers.set(handle, () => Reflect.apply(callback, undefined, []));
          return handle;
        },
        clearTimeout: (handle?: number) => {
          if (handle !== undefined) timers.delete(handle);
        },
      },
    });
    const plugin = await realm.load();
    expect(fetch).not.toHaveBeenCalled();
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    expect(obsidian.host.vault.on.mock.invocationCallOrder.at(-1)).toBeLessThan(
      obsidian.host.onLayoutReady.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );

    obsidian.host.becomeLayoutReady();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const file = addSavedNote();
    obsidian.host.emitVault("modify", file);
    await vi.waitFor(() => expect(timers.size).toBe(1));
    now = 1_000;
    const wake = [...timers.values()][0];
    timers.clear();
    wake?.();

    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init.method === "PUT")).toBe(
        true,
      ),
    );
    const mutation = fetch.mock.calls.find(([, init]) => init.method === "PUT");
    if (mutation === undefined) throw new Error("Expected a packaged PUT");
    const [url, init] = mutation;
    const headers = new Headers(init.headers);
    expect(url.pathname).toBe(`/api/v2/notes/${ENCODED_NOTE_PATH}`);
    expect(url.pathname).not.toContain("/api/v1/");
    expect(init.body).toBe(NOTE_BODY);
    expect(headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Bridge-Association-Id")).toBe(ASSOCIATION_ID);
    expect(headers.get("Bridge-Writer-Id")).toBe(DEVICE_ID);
    expect(headers.get("Bridge-Operation-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers.get("If-None-Match")).toBe("*");
    expect(headers.has("If-Match")).toBe(false);
    expect(
      fetch.mock.calls.every(([request]) =>
        request.pathname.startsWith("/api/v2/"),
      ),
    ).toBe(true);
    expect(obsidian.host.getSecret).toHaveBeenCalledWith(SECRET_REFERENCE);
    expect(obsidian.host.request).not.toHaveBeenCalled();
    expect(obsidian.host.requestUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(obsidian.host.loadData.mock.results)).not.toContain(
      BEARER,
    );
    expect([...obsidian.host.localStorage.values()].join("\n")).not.toContain(
      NOTE_BODY,
    );
    plugin.unload();
  });

  it("reuses the actual same-realm owner across bundle replacement while a packaged mutation remains in flight", async () => {
    configureActiveWriter();
    const file = addSavedNote();
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const contentHash = await sha256(NOTE_BODY);
    const pendingInventory = Promise.withResolvers<Response>();
    const pendingMutation = Promise.withResolvers<Response>();
    let inventoryRequests = 0;
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname === "/api/v2/mirror") {
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
          inventoryRequests += 1;
          return inventoryRequests === 1
            ? pendingInventory.promise
            : json({ notes: [], nextCursor: null });
        }
        if (url.pathname.endsWith("/state")) {
          return json({ kind: "absent", path: NOTE_PATH });
        }
        if (init.method === "PUT") return pendingMutation.promise;
        return json(
          { error: { code: "not_found", message: "Not found." } },
          404,
        );
      },
    );
    const realm = new ArtifactRealm({
      fetch,
      performance: { now: () => now },
      window: {
        setTimeout: (callback: TimerHandler) => {
          if (typeof callback !== "function") {
            throw new Error("Expected a callback timer");
          }
          const handle = nextTimer++;
          timers.set(handle, () => Reflect.apply(callback, undefined, []));
          return handle;
        },
        clearTimeout: (handle?: number) => {
          if (handle !== undefined) timers.delete(handle);
        },
      },
    });
    const app = new App();
    const runtimeA = await realm.load(app);
    obsidian.host.becomeLayoutReady();
    await vi.waitFor(() => expect(timers.size).toBe(2));
    now = 1_000;
    const wakeEntry = [...timers.entries()].at(-1);
    if (wakeEntry === undefined) throw new Error("Expected a wake timer");
    timers.delete(wakeEntry[0]);
    wakeEntry[1]();
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
      ).toHaveLength(1),
    );

    runtimeA.unload();
    const runtimeB = await realm.load(app);
    expect(obsidian.host.loadLocalStorage).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname === "/api/v2/mirror"),
    ).toHaveLength(1);
    expect(obsidian.host.vault.getFiles).toHaveBeenCalledTimes(1);
    const pendingPut = fetch.mock.calls.find(
      ([, init]) => init.method === "PUT",
    );
    const operationId = new Headers(pendingPut?.[1].headers).get(
      "Bridge-Operation-Id",
    );
    if (operationId === null) {
      throw new Error("Expected the retained packaged operation identity");
    }
    pendingMutation.resolve(
      json(
        {
          path: NOTE_PATH,
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
        { ETag: `"m3-${REVISION}"` },
      ),
    );
    pendingInventory.resolve(json({ notes: [], nextCursor: null }));
    await vi.waitFor(() => {
      const persisted = obsidian.host.localStorage.get(STATE_KEY);
      if (typeof persisted !== "string") {
        throw new Error("Expected persisted packaged runtime state");
      }
      expect(persisted).toContain(operationId);
      expect(persisted).toContain('"phase":"evidence-required"');
    });
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
    ).toHaveLength(1);
    expect(obsidian.host.contents.get(file)).toBe(NOTE_BODY);
    runtimeB.unload();
  });

  it("fails closed when the generated bundle encounters an incompatible registry version", async () => {
    const realm = new ArtifactRealm();
    realm.installIncompatibleRegistry();
    const plugin = await realm.load();
    expect([...obsidian.host.commands.keys()]).toEqual([
      "ai-bridge:inspect-local-notes",
      "ai-bridge:inspect-active-note",
      "ai-bridge:show-mirror-status",
    ]);
    expect(obsidian.host.settingsTabs.size).toBe(0);
    expect(obsidian.host.vaultListeners.size).toBe(0);
    expect(obsidian.host.loadLocalStorage).not.toHaveBeenCalled();
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    plugin.unload();
  });

  it("serializes a pending M2 read across unload and re-enable without stale UI", async () => {
    const realm = new ArtifactRealm();
    const plugin = await realm.load();
    const file = new TFile();
    file.path = "active.md";
    file.stat = { size: 0, mtime: 1_000, ctime: 1_000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.active = file;
    const pending = Promise.withResolvers<string>();
    obsidian.host.vault.read.mockReturnValue(pending.promise);
    const inspect = command("ai-bridge:inspect-active-note");
    const work = inspect();
    plugin.unload();
    await inspect();
    await plugin.load();
    const replacement = plugin;
    await command("ai-bridge:inspect-local-notes")();
    const currentNotice = obsidian.host.notices.at(-1);
    const listCallsBeforeSettle =
      obsidian.host.vault.getFiles.mock.calls.length;
    const modalCountBeforeSettle = obsidian.host.modals.size;
    pending.resolve("");
    await work;
    expect(obsidian.host.vault.read).toHaveBeenCalledTimes(1);
    expect(listCallsBeforeSettle).toBe(0);
    expect(modalCountBeforeSettle).toBe(0);
    expect(currentNotice?.message).toBe("An inspection is already running.");
    expect(obsidian.host.notices).toEqual([currentNotice]);
    expect(obsidian.host.modals.size).toBe(0);
    await command("ai-bridge:inspect-local-notes")();
    expect(obsidian.host.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(obsidian.host.modals.size).toBe(1);
    replacement.unload();
    expect(currentNotice?.hidden).toBe(true);
  });
});
