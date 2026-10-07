import {
  DEMO_CONFIG_KEY,
  decodeDemoConfig,
} from "@obsidian-plugin/demo/demo-config";
import { acquireDemoOwner } from "@obsidian-plugin/demo/demo-owner";
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
const config = {
  mode: "synthetic-local-only",
  endpoint: "http://127.0.0.1:8789",
  vaultId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  paths: ["demo.md"],
  secretReference: "demo-native-secret",
  acknowledgement: "DISPOSABLE SYNTHETIC VAULT",
};
beforeEach(resetHost);
describe("experimental owner admission", () => {
  it.each([
    null,
    "{",
    JSON.stringify({ ...config, endpoint: "https://example.com" }),
    JSON.stringify({ ...config, acknowledgement: "yes" }),
    JSON.stringify({ ...config, token: "secret" }),
  ])("rejects unarmed or unsafe configuration", (value) => {
    expect(decodeDemoConfig(value)).toBeNull();
  });
  it("retains one owner and blocks stale/unready sessions without network", async () => {
    const app = new App();
    const parsed = decodeDemoConfig(JSON.stringify(config));
    if (!parsed) throw new Error("Bad fixture");
    host.localStorage.set(DEMO_CONFIG_KEY, JSON.stringify(config));
    const fetcher: typeof fetch = vi.fn(async () =>
      Response.json({ kind: "never_seen" }),
    );
    const owner = acquireDemoOwner(app, parsed, fetcher);
    if (!owner) throw new Error("Missing owner");
    const token = owner.attach();
    expect(await owner.syncNow(token)).toBe("attention");
    expect(fetcher).not.toHaveBeenCalled();
    owner.detach(token);
    const same = acquireDemoOwner(app, parsed, fetcher);
    expect(same).toBe(owner);
    const next = owner.attach();
    owner.ready(next);
    expect(await owner.syncNow(token)).toBe("attention");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      acquireDemoOwner(app, { ...parsed, secretReference: "other" }, fetcher),
    ).toBeNull();
  });
});
