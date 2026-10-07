import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  syncDemoRequestSchema,
  type syncDemoResponseSchema,
  syncDeviceIdSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  DEMO_CONFIG_KEY,
  decodeDemoConfig,
  demoLedgerKey,
} from "@obsidian-plugin/demo/demo-config";
import DemoPlugin from "@obsidian-plugin/demo/demo-main";
import {
  FileNode,
  isPlugin,
  SimApp,
} from "@obsidian-plugin-tests/artifact/demo-host";
import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("obsidian", async () => {
  const { SimApp: Base, simulatedObsidian } = await import(
    "@obsidian-plugin-tests/artifact/demo-host"
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  class AppDouble extends Base {
    constructor() {
      super(fs.mkdtempSync(path.join(os.tmpdir(), "m8-source-plugin-")));
    }
  }
  return { ...simulatedObsidian, App: AppDouble };
});
const apps: SimApp[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0))
    rmSync(app.directory, { recursive: true, force: true });
});
const config = {
  mode: "synthetic-local-only",
  endpoint: "http://127.0.0.1:8789",
  vaultId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  paths: ["demo.md"],
  secretReference: "demo-native-secret",
  acknowledgement: "DISPOSABLE SYNTHETIC VAULT",
};
type Live = Extract<z.infer<typeof syncDemoResponseSchema>, { kind: "live" }>;
function fixture() {
  const app = new App();
  if (!(app instanceof SimApp)) throw new Error("Not a simulated App");
  apps.push(app);
  app.secrets.set("demo-native-secret", "synthetic-native-bearer");
  const versions = new Map<string, { head: Live; content: string }>();
  let head: Live | null = null;
  let beforeFetch: (() => Promise<void>) | null = null;
  const fetcher: typeof fetch = vi.fn(async (_url, init) => {
    await beforeFetch?.();
    if (typeof init?.body !== "string") throw new Error("Missing command");
    const request = syncDemoRequestSchema.parse(JSON.parse(init.body));
    switch (request.operation) {
      case "current":
        return Response.json(head ?? { kind: "never_seen" });
      case "version": {
        const v = versions.get(request.revision);
        return Response.json(
          v
            ? {
                kind: "present",
                version: {
                  ...v.head,
                  content: v.content,
                  path: "demo.md",
                  vaultId: config.vaultId,
                },
              }
            : { kind: "absent" },
        );
      }
      case "changes":
        return Response.json({
          kind: "page",
          events: [],
          nextCursor: request.cursor,
        });
      case "mutate": {
        const mutation = request.mutation;
        const published: Live = {
          kind: "live",
          revision: mutation.revision,
          parent: mutation.parent,
          operationId: mutation.operationId,
          origin: syncDeviceIdSchema.parse(config.deviceId),
          contentSha256: createHash("sha256")
            .update(mutation.content)
            .digest("hex"),
          byteSize: Buffer.byteLength(mutation.content),
          mediaType: "text/markdown",
        };
        head = published;
        versions.set(published.revision, {
          head: published,
          content: mutation.content,
        });
        return Response.json({
          kind: "committed",
          revision: published.revision,
          operationId: published.operationId,
          position: { lane: 0, sequence: "00000000000000000001" },
        });
      }
    }
  });
  vi.stubGlobal("fetch", fetcher);
  const plugin = new DemoPlugin(app, {
    id: "ai-bridge-synthetic-demo",
    name: "Demo",
    version: "0.0.0",
    minAppVersion: "1.13.0",
    description: "Synthetic",
    author: "Test",
  });
  plugin.onload();
  return {
    app,
    plugin,
    fetcher,
    versions,
    get head() {
      return head;
    },
    setHead: (value: Live) => {
      head = value;
    },
    hook: (callback: (() => Promise<void>) | null) => {
      beforeFetch = callback;
    },
  };
}
describe("synthetic source plugin composition", () => {
  it("requires explicit arming, saves only local config/ledger and publishes saved Markdown through a native secret", async () => {
    const f = fixture();
    expect(await f.plugin.syncNow()).toBe("attention");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.plugin.configurationText()).toContain('"acknowledgement": ""');
    f.plugin.setSecretReference("demo-native-secret");
    f.plugin.configure(JSON.stringify(config));
    expect(f.plugin.statusText()).toBe("Ready");
    const file = await f.app.vault.create("demo.md", "synthetic saved bytes");
    expect(await f.plugin.syncNow()).toBe("settled");
    expect(f.head?.contentSha256).toBe(
      createHash("sha256")
        .update(await f.app.vault.read(file))
        .digest("hex"),
    );
    const parsed = decodeDemoConfig(JSON.stringify(config));
    if (!parsed) throw new Error("Bad config");
    const ledger = f.app.loadLocalStorage(demoLedgerKey(parsed));
    expect(typeof ledger).toBe("string");
    expect(ledger).not.toContain("synthetic saved bytes");
    expect(ledger).not.toContain("synthetic-native-bearer");
    expect(f.plugin.secretReference()).toBe("demo-native-secret");
    f.plugin.setSecretReference("other");
    expect(f.plugin.statusText()).toBe("attention");
    f.plugin.configure(
      JSON.stringify({ ...config, endpoint: "https://example.com" }),
    );
    expect(f.plugin.statusText()).toBe("attention");
    f.plugin.onunload();
    expect(await f.plugin.syncNow()).toBe("attention");
  });
  it("applies remote bytes with exact process, retains successor events and preserves raced/local conflict bytes", async () => {
    const f = fixture();
    f.plugin.configure(JSON.stringify(config));
    const file = await f.app.vault.create("demo.md", "base");
    await f.plugin.syncNow();
    const base = f.head;
    if (!base) throw new Error("Missing base");
    const remote: Live = {
      ...base,
      revision: syncRevisionSchema.parse(
        "44444444-4444-4444-8444-444444444444",
      ),
      operationId: syncOperationIdSchema.parse(
        "55555555-5555-4555-8555-555555555555",
      ),
      parent: { kind: "revision", revision: base.revision },
      contentSha256: createHash("sha256").update("remote").digest("hex"),
      byteSize: 6,
    };
    f.versions.set(remote.revision, { head: remote, content: "remote" });
    f.setHead(remote);
    expect(await f.plugin.syncNow()).toBe("pending");
    expect(await f.app.vault.read(file)).toBe("remote");
    expect(await f.plugin.syncNow()).toBe("settled");
    await f.app.vault.edit(file, "local conflict");
    const competitor: Live = {
      ...remote,
      revision: syncRevisionSchema.parse(
        "66666666-6666-4666-8666-666666666666",
      ),
      parent: { kind: "revision", revision: remote.revision },
      contentSha256: createHash("sha256").update("competitor").digest("hex"),
      byteSize: 10,
    };
    f.versions.set(competitor.revision, {
      head: competitor,
      content: "competitor",
    });
    f.setHead(competitor);
    expect(await f.plugin.syncNow()).toBe("attention");
    expect(await f.app.vault.read(file)).toBe("local conflict");
    const copy = f.app.vault
      .getAllLoadedFiles()
      .find(
        (node) =>
          node instanceof FileNode &&
          node.path.startsWith("ai-bridge-conflicts/"),
      );
    if (!(copy instanceof FileNode)) throw new Error("No verified copy");
    expect(await f.app.vault.read(copy)).toBe("competitor");
    f.plugin.onunload();
  });
  it("retains busy settlement and refuses stale later dispatch across unload/re-enable", async () => {
    const f = fixture();
    f.plugin.configure(JSON.stringify(config));
    await f.app.vault.create("demo.md", "saved");
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    f.hook(async () => {
      if (++calls === 1) await paused;
    });
    const running = f.plugin.syncNow();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    f.plugin.onunload();
    f.plugin.onload();
    expect(await f.plugin.syncNow()).toBe("pending");
    release?.();
    expect(await running).toBe("attention");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await f.plugin.syncNow()).toBe("settled");
    f.plugin.onunload();
  });
  it("fails closed on unreadable or unverified host-local configuration without creating an owner", async () => {
    const f = fixture();
    vi.spyOn(f.app, "loadLocalStorage").mockImplementationOnce(() => {
      throw new Error("Unavailable");
    });
    expect(f.plugin.configurationText()).toBe("");
    vi.spyOn(f.app, "saveLocalStorage").mockImplementationOnce(() => {});
    f.plugin.configure(JSON.stringify(config));
    expect(f.plugin.statusText()).toBe("attention");
    expect(await f.plugin.syncNow()).toBe("attention");
    expect(f.fetcher).not.toHaveBeenCalled();
    vi.spyOn(f.app, "loadLocalStorage").mockReturnValue({ unsupported: true });
    f.plugin.onload();
    expect(f.plugin.statusText()).toBe("attention");
    f.plugin.unload();
  });
  it("uses the actual settings draft/native selector/apply and Sync now button without automatic dispatch", async () => {
    const f = fixture();
    if (!isPlugin(f.plugin)) throw new Error("Missing controls");
    f.app.secretControls[0]?.change("demo-native-secret");
    const input = f.app.inputs.at(-1);
    if (!input) throw new Error("Missing draft");
    input.change(JSON.stringify(config));
    f.plugin.buttons
      .find((button) => button.text === "Apply disposable configuration")
      ?.click();
    expect(f.plugin.statusText()).toBe("Ready");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.plugin.buttons.find((button) => button.text === "Sync now")?.click();
    await vi.waitFor(() => expect(f.plugin.statusText()).toBe("settled"));
    expect(f.fetcher).toHaveBeenCalled();
    f.plugin.unload();
  });
  it("fences dispatch after secret retrieval when unload wins the await boundary", async () => {
    const f = fixture();
    f.plugin.configure(JSON.stringify(config));
    await f.app.vault.create("demo.md", "saved");
    vi.spyOn(f.app.secretStorage, "getSecret").mockImplementation(() => {
      queueMicrotask(() => f.plugin.unload());
      return "synthetic-native-bearer";
    });
    expect(await f.plugin.syncNow()).toBe("attention");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses corrupt/unavailable config and ledger without resetting or writing targets", async () => {
    const f = fixture();
    f.app.saveLocalStorage(DEMO_CONFIG_KEY, "{");
    f.plugin.onload();
    expect(f.plugin.statusText()).toBe("Not armed");
    f.plugin.configure(JSON.stringify(config));
    const parsed = decodeDemoConfig(JSON.stringify(config));
    if (!parsed) throw new Error("Bad config");
    f.app.saveLocalStorage(demoLedgerKey(parsed), "unsupported");
    expect(await f.plugin.syncNow()).toBe("attention");
    expect(f.app.loadLocalStorage(demoLedgerKey(parsed))).toBe("unsupported");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.app.vault.effects).toEqual([]);
    f.plugin.onunload();
  });
});
