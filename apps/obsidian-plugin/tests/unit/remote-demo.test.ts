import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  DEMO_CONFIG_KEY,
  decodeDemoConfig,
  demoLedgerKey,
  readDemoString,
} from "@obsidian-plugin/demo/demo-config";
import { acquireDemoOwner } from "@obsidian-plugin/demo/demo-owner";
import RemotePlugin from "@obsidian-plugin/demo/remote-main";
import {
  nextRemoteTicket,
  REMOTE_DEMO_PROFILE,
} from "@obsidian-plugin/demo/remote-profile";
import { SyncDemoFetchRemote } from "@obsidian-plugin/demo/sync-demo-fetch";
import { SyncDemoLedgerRepository } from "@obsidian-plugin/demo/sync-demo-ledger";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App, TFile } from "obsidian";
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
  it("requires a separate persisted opt-in and cancels the owner schedule on disable", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const status = vi.fn();
      const lease = owner.attach(status);
      owner.ready(lease);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).not.toHaveBeenCalled();
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith("settled");
      owner.observed(lease, "demo.md");
      owner.observed(lease, "demo.md");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(2);
      owner.observed(lease, "moved.md", "demo.md");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(3);
      expect(owner.setAutomatic(lease, false)).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("backs off pending passes, stops on attention and fences detached callbacks", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi
        .spyOn(owner, "syncNow")
        .mockResolvedValueOnce("pending")
        .mockResolvedValue("attention");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(pass).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(pass).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).toHaveBeenCalledTimes(2);
      owner.detach(lease);
      owner.observed(lease, "demo.md");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not schedule a successor when the opt-in is disabled during an unsettled pass", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      let settle: ((result: "settled") => void) | undefined;
      const suspended = new Promise<"settled">((resolve) => {
        settle = resolve;
      });
      const pass = vi
        .spyOn(owner, "syncNow")
        .mockReturnValueOnce(suspended)
        .mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(1);
      expect(owner.setAutomatic(lease, false)).toBe(true);
      settle?.("settled");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("lets a newer opt-in schedule survive settlement of an older automatic pass", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      let settle: ((result: "settled") => void) | undefined;
      const oldPass = new Promise<"settled">((resolve) => {
        settle = resolve;
      });
      const pass = vi
        .spyOn(owner, "syncNow")
        .mockReturnValueOnce(oldPass)
        .mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(1);
      expect(owner.setAutomatic(lease, false)).toBe(true);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      settle?.("settled");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a replacement session schedule when the detached session's pass settles late", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      let settle: ((result: "settled") => void) | undefined;
      const oldPass = new Promise<"settled">((resolve) => {
        settle = resolve;
      });
      const pass = vi
        .spyOn(owner, "syncNow")
        .mockReturnValueOnce(oldPass)
        .mockResolvedValue("settled");
      const original = owner.attach();
      owner.ready(original);
      expect(owner.setAutomatic(original, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      owner.detach(original);
      const replacement = owner.attach();
      owner.ready(replacement);
      settle?.("settled");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a failed disable latched across same-App plugin reload", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      const write = vi
        .spyOn(app, "saveLocalStorage")
        .mockImplementationOnce(() => {});
      expect(owner.setAutomatic(lease, false)).toBe(false);
      write.mockRestore();
      owner.detach(lease);
      const replacement = owner.attach();
      owner.ready(replacement);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed when host storage throws during opt-in reads or disable", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      const read = vi
        .spyOn(app, "loadLocalStorage")
        .mockImplementation((key) => {
          if (key === REMOTE_DEMO_PROFILE.automaticKey)
            throw new Error("unavailable");
          return host.localStorage.get(key) ?? null;
        });
      expect(owner.automaticEnabled()).toBe(false);
      read.mockRestore();
      const write = vi.spyOn(app, "saveLocalStorage").mockImplementation(() => {
        throw new Error("unavailable");
      });
      expect(owner.setAutomatic(lease, false)).toBe(false);
      write.mockRestore();
      owner.detach(lease);
      const replacement = owner.attach();
      owner.ready(replacement);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops automatic traffic on an unreadable durable ledger and stays stopped after reattach", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      host.localStorage.set(demoLedgerKey(c, REMOTE_DEMO_PROFILE), "{broken");
      const fetcher = vi.fn<typeof fetch>();
      const owner = acquireDemoOwner(app, c, fetcher, REMOTE_DEMO_PROFILE);
      if (!owner) throw new Error("missing owner");
      const result = vi.fn();
      const original = owner.attach(result);
      owner.ready(original);
      expect(owner.setAutomatic(original, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result).toHaveBeenCalledWith("attention");
      expect(fetcher).not.toHaveBeenCalled();
      owner.detach(original);
      const replacement = owner.attach(result);
      owner.ready(replacement);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops the automatic owner after a real transport authentication refusal", async () => {
    const app = new App();
    const c = parsed();
    const file = Object.assign(new TFile(), { path: "demo.md" });
    host.files.set(file.path, file);
    host.contents.set(file, "hello");
    Object.assign(host.vault, {
      getAllLoadedFiles: () => [...host.files.values()],
    });
    try {
      host.secrets.set(c.secretReference, "synthetic-token");
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 401 }),
      );
      const owner = acquireDemoOwner(app, c, fetcher, REMOTE_DEMO_PROFILE);
      if (!owner) throw new Error("missing owner");
      const result = vi.fn();
      const lease = owner.attach(result);
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.waitFor(() => expect(result).toHaveBeenCalledWith("attention"));
      expect(fetcher).toHaveBeenCalledTimes(1);
      owner.observed(lease, "demo.md");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fetcher).toHaveBeenCalledTimes(1);
      owner.detach(lease);
    } finally {
      Reflect.deleteProperty(host.vault, "getAllLoadedFiles");
    }
  });
  it("waits when a manual pass owns the client instead of starting an overlapping automatic pass", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const busy = vi.spyOn(owner, "isBusy").mockReturnValueOnce(true);
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).not.toHaveBeenCalled();
      busy.mockRestore();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits for a durable prepared push retry floor before starting another automatic pass", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      const key = demoLedgerKey(c, REMOTE_DEMO_PROFILE);
      const store = new SyncDemoLedgerRepository(
        {
          read: async () => readDemoString(app, key),
          write: async (value) => app.saveLocalStorage(key, value),
        },
        c,
      );
      const loaded = await store.load();
      if (loaded.kind !== "ready") throw new Error("missing fixture ledger");
      const entry = loaded.ledger.entries[0];
      if (entry === undefined) throw new Error("missing fixture entry");
      const hash = createContentSha256("a".repeat(64));
      if (hash === undefined) throw new Error("invalid fixture hash");
      expect(
        await store.save({
          ...loaded.ledger,
          entries: [
            {
              ...entry,
              work: {
                kind: "push",
                certainty: "uncertain",
                operationId: syncOperationIdSchema.parse(
                  "44444444-4444-4444-8444-444444444444",
                ),
                revision: syncRevisionSchema.parse(
                  "55555555-5555-4555-8555-555555555555",
                ),
                parent: { kind: "never_seen" },
                contentSha256: hash,
                retryAfterEpochMs: Date.now() + 30_000,
              },
            },
          ],
        }),
      ).toBe(true);
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      expect(owner.setAutomatic(lease, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pass).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("records typed retry floors and HTTP 429 Retry-After before allowing another remote ticket", async () => {
    const c = parsed();
    const floor = Date.now() + 30_000;
    const typedTicket = vi.fn(() => "0");
    const typedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "error",
        code: "storage_throttled",
        retryAfterEpochMs: floor,
      }),
    );
    const typed = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "token",
      typedFetch,
      10_000,
      { endpoint: c.endpoint, ticket: typedTicket },
    );
    await typed.current(path);
    expect(typed.retryFloorEpochMs()).toBe(floor);
    await typed.current(path);
    expect(typedTicket).toHaveBeenCalledTimes(1);
    expect(typedFetch).toHaveBeenCalledTimes(1);
    const limitedTicket = vi.fn(() => "0");
    const limitedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
    );
    const limited = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "token",
      limitedFetch,
      10_000,
      { endpoint: c.endpoint, ticket: limitedTicket },
    );
    await limited.current(path);
    expect(limited.retryFloorEpochMs()).toBeGreaterThanOrEqual(
      Date.now() + 29_000,
    );
    await limited.current(path);
    expect(limitedTicket).toHaveBeenCalledTimes(1);
    expect(limitedFetch).toHaveBeenCalledTimes(1);
    const dated = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "token",
      vi.fn<typeof fetch>(
        async () =>
          new Response(null, {
            status: 429,
            headers: {
              "Retry-After": new Date(Date.now() + 60_000).toUTCString(),
            },
          }),
      ),
      10_000,
      { endpoint: c.endpoint, ticket: () => "0" },
    );
    await dated.current(path);
    expect(dated.retryFloorEpochMs()).toBeGreaterThanOrEqual(
      Date.now() + 59_000,
    );
  });
  it("uses the injected clock domain to release a retry floor without spending an early ticket", async () => {
    const c = parsed();
    let now = 2_000_000_000_000;
    const ticket = vi.fn(() => "0");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          kind: "error",
          code: "storage_throttled",
          retryAfterEpochMs: now + 10_000,
        }),
      )
      .mockResolvedValueOnce(Response.json({ kind: "never_seen" }));
    const remote = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "token",
      fetcher,
      10_000,
      { endpoint: c.endpoint, ticket },
      () => now,
    );
    await remote.current(path);
    now += 9_999;
    await remote.current(path);
    expect(ticket).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await remote.current(path)).toEqual({ kind: "never_seen" });
    expect(ticket).toHaveBeenCalledTimes(2);
  });
  it("fails closed on changed binding, corrupt opt-in, exhausted tickets and unverifiable opt-in writes", async () => {
    vi.useFakeTimers();
    try {
      const app = new App();
      const c = parsed();
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const owner = acquireDemoOwner(
        app,
        c,
        vi.fn<typeof fetch>(),
        REMOTE_DEMO_PROFILE,
      );
      if (!owner) throw new Error("missing owner");
      const pass = vi.spyOn(owner, "syncNow").mockResolvedValue("settled");
      const lease = owner.attach();
      owner.ready(lease);
      host.localStorage.set(REMOTE_DEMO_PROFILE.automaticKey ?? "", "corrupt");
      expect(owner.setAutomatic(lease, true)).toBe(false);
      host.localStorage.delete(REMOTE_DEMO_PROFILE.automaticKey ?? "");
      const save = vi
        .spyOn(app, "saveLocalStorage")
        .mockImplementationOnce(() => {});
      expect(owner.setAutomatic(lease, true)).toBe(false);
      save.mockRestore();
      expect(owner.setAutomatic(lease, true)).toBe(true);
      host.localStorage.set(
        REMOTE_DEMO_PROFILE.configKey,
        JSON.stringify({ ...c, paths: ["other.md"] }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).not.toHaveBeenCalled();
      owner.detach(lease);
      host.localStorage.set(REMOTE_DEMO_PROFILE.configKey, JSON.stringify(c));
      const next = owner.attach();
      owner.ready(next);
      host.localStorage.set(
        `ai-bridge:synthetic-remote:tickets:v1:${c.experimentId}:${c.vaultId}:${c.deviceId}`,
        "100",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pass).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("marks a stopped or expired remote lab response terminal for the owner scheduler", async () => {
    const c = parsed();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    const remote = new SyncDemoFetchRemote(
      c.endpoint,
      c,
      async () => "synthetic-token",
      fetcher,
      10_000,
      { endpoint: c.endpoint, ticket: () => "0" },
    );
    expect((await remote.current(path)).kind).toBe("error");
    expect(remote.isTerminal()).toBe(true);
    expect((await remote.current(path)).kind).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
    expect(plugin.automaticSyncEnabled()).toBe(false);
    host.becomeLayoutReady();
    expect(plugin.setAutomaticSync(true)).toBe(true);
    expect(host.localStorage.get(REMOTE_DEMO_PROFILE.automaticKey ?? "")).toBe(
      JSON.stringify(parsed()),
    );
    const disable = vi
      .spyOn(app, "saveLocalStorage")
      .mockImplementationOnce(() => {});
    expect(plugin.setAutomaticSync(false)).toBe(false);
    expect(plugin.statusText()).toContain("full restart may resume");
    expect(plugin.automaticSyncEnabled()).toBe(true);
    disable.mockRestore();
    expect(plugin.setAutomaticSync(false)).toBe(true);
    expect(plugin.automaticSyncEnabled()).toBe(false);
    plugin.onunload();
  });
});
