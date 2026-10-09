import { syncNotePathSchema } from "@obsidian-ai-bridge/protocol";
import {
  DEMO_CONFIG_KEY,
  decodeDemoConfig,
  demoLedgerKey,
} from "@obsidian-plugin/demo/demo-config";
import { acquireDemoOwner } from "@obsidian-plugin/demo/demo-owner";
import RemotePlugin from "@obsidian-plugin/demo/remote-main";
import {
  nextRemoteTicket,
  REMOTE_DEMO_PROFILE,
} from "@obsidian-plugin/demo/remote-profile";
import { SyncDemoFetchRemote } from "@obsidian-plugin/demo/sync-demo-fetch";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);
const path = syncNotePathSchema.parse("demo.md");
const config = {
  mode: "synthetic-remote-only",
  endpoint: "https://synthetic.example.test",
  experimentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  vaultId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  paths: ["demo.md"],
  secretReference: "remote-native-secret",
  acknowledgement: "DISPOSABLE SYNTHETIC VAULT",
};
function parsed() {
  const value = decodeDemoConfig(JSON.stringify(config), REMOTE_DEMO_PROFILE);
  if (!value) throw new Error("bad fixture");
  return value;
}
beforeEach(resetHost);
describe("remote synthetic plugin", () => {
  it.each([
    "http://127.0.0.1:8789",
    "https://synthetic.example.test/",
    "https://synthetic.example.test/path",
    "https://user@synthetic.example.test",
    "https://synthetic.example.test?x",
    "https://synthetic.example.test:8443",
  ])("refuses unsafe/noncanonical endpoint %s", (endpoint) => {
    expect(
      decodeDemoConfig(
        JSON.stringify({ ...config, endpoint }),
        REMOTE_DEMO_PROFILE,
      ),
    ).toBeNull();
  });
  it("requires fresh remote arming and never admits HTTPS in the local profile", () => {
    expect(decodeDemoConfig(JSON.stringify(config))).toBeNull();
    expect(
      decodeDemoConfig(
        JSON.stringify({ ...config, experimentId: undefined }),
        REMOTE_DEMO_PROFILE,
      ),
    ).toBeNull();
    expect(
      decodeDemoConfig(
        JSON.stringify({ ...config, mode: "synthetic-local-only" }),
        REMOTE_DEMO_PROFILE,
      ),
    ).toBeNull();
    expect(demoLedgerKey(parsed(), REMOTE_DEMO_PROFILE)).not.toContain(
      "ai-bridge:synthetic-demo:ledger",
    );
  });
  it("persists monotonically before dispatch and fences corrupt/read-back/exhausted state", () => {
    const app = new App();
    const c = parsed();
    expect(nextRemoteTicket(app, c)).toBe("0");
    expect(nextRemoteTicket(app, c)).toBe("1");
    for (const _ of Array.from({ length: 98 }))
      expect(nextRemoteTicket(app, c)).not.toBeNull();
    expect(nextRemoteTicket(app, c)).toBeNull();
    host.localStorage.clear();
    vi.spyOn(app, "saveLocalStorage").mockImplementation(() => {});
    expect(nextRemoteTicket(app, c)).toBeNull();
    vi.restoreAllMocks();
    host.localStorage.set(
      `ai-bridge:synthetic-remote:tickets:v1:${config.experimentId}:${config.vaultId}:${config.deviceId}`,
      "bad",
    );
    expect(nextRemoteTicket(app, c)).toBeNull();
  });
  it("refuses malformed mode and storage exceptions without resetting consumed authority", () => {
    const app = new App();
    const c = parsed();
    expect(
      nextRemoteTicket(app, { ...c, mode: "synthetic-local-only" }),
    ).toBeNull();
    expect(nextRemoteTicket(app, { ...c, experimentId: undefined })).toBeNull();
    const save = vi.spyOn(app, "saveLocalStorage").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(nextRemoteTicket(app, c)).toBeNull();
    save.mockRestore();
    expect(nextRemoteTicket(app, c)).toBe("0");
    const read = vi.spyOn(app, "loadLocalStorage").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(nextRemoteTicket(app, c)).toBeNull();
    read.mockRestore();
    expect(nextRemoteTicket(app, c)).toBe("1");
  });
  it("pins HTTPS dispatch to the original endpoint and sends paired identity + consumed ticket, no redirects", async () => {
    const c = parsed();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ kind: "never_seen" }),
    );
    const app = new App();
    const remote = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "fresh-token",
      fetcher,
      10_000,
      { endpoint: c.endpoint, ticket: () => nextRemoteTicket(app, c) },
    );
    expect(await remote.current(path)).toEqual({ kind: "never_seen" });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://synthetic.example.test/demo/v1/request");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-AI-Bridge-Remote-Ticket")).toBe("0");
    expect(headers.get("X-AI-Bridge-Demo-Vault-Id")).toBe(config.vaultId);
    expect(headers.get("X-AI-Bridge-Demo-Origin")).toBe(config.deviceId);
    expect(
      () =>
        new SyncDemoFetchRemote(
          "https://foreign.example.test",
          c,
          async () => null,
          fetcher,
          10_000,
          { endpoint: c.endpoint, ticket: () => "1" },
        ),
    ).toThrow();
    const fenced = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "fresh-token",
      fetcher,
      10_000,
      { endpoint: c.endpoint, ticket: () => null },
    );
    expect((await fenced.current(path)).kind).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("isolates owner/config and retains exact endpoint across reload/reconfiguration", async () => {
    const app = new App();
    const c = parsed();
    host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ kind: "never_seen" }),
    );
    const owner = acquireDemoOwner(app, c, fetcher, REMOTE_DEMO_PROFILE);
    if (!owner) throw new Error("missing owner");
    expect(acquireDemoOwner(app, c, fetcher, REMOTE_DEMO_PROFILE)).toBe(owner);
    expect(
      acquireDemoOwner(
        app,
        { ...c, endpoint: "https://foreign.example.test" },
        fetcher,
        REMOTE_DEMO_PROFILE,
      ),
    ).toBeNull();
    const lease = owner.attach();
    owner.ready(lease);
    host.localStorage.set(DEMO_CONFIG_KEY, JSON.stringify(c));
    host.localStorage.delete(REMOTE_DEMO_PROFILE.configKey);
    expect(await owner.syncNow(lease)).toBe("attention");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads the remote plugin without borrowing local config and arms only remote settings", () => {
    const app = new App();
    host.localStorage.set(DEMO_CONFIG_KEY, JSON.stringify(config));
    const plugin = new RemotePlugin(app, {
      id: "ai-bridge-synthetic-remote",
      name: "remote",
      author: "test",
      version: "0.0.0",
      minAppVersion: "1.13.0",
      description: "test",
    });
    plugin.onload();
    expect(plugin.statusText()).toBe("Not armed");
    plugin.configure(JSON.stringify(config));
    expect(host.localStorage.get(REMOTE_DEMO_PROFILE.configKey)).toBe(
      JSON.stringify(parsed()),
    );
    expect(plugin.secretReference()).toBe("remote-native-secret");
    plugin.onunload();
  });
});
