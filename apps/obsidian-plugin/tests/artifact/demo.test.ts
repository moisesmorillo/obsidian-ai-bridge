import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactPlugin,
  artifactRealm,
  FileNode,
  SimApp,
} from "@obsidian-plugin-tests/artifact/demo-host";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundle = readFileSync(
  new URL("../../dist/demo-plugin/main.js", import.meta.url),
  "utf8",
);
const manifestText = readFileSync(
  new URL("../../dist/demo-plugin/manifest.json", import.meta.url),
  "utf8",
);
const directory = mkdtempSync(join(tmpdir(), "m8-plugin-demo-"));
const vaultId = "11111111-1111-4111-8111-111111111111";
const origins = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const ids = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
];
const tokens = [
  "disposable-demo-A",
  "disposable-demo-B",
  "disposable-demo-REST",
];
const configKey = "ai-bridge:synthetic-demo:configuration:v1";
let runtime: Miniflare | undefined;
const requestCounts: number[] = [];
let currentCalls = 0;
const fetcher: typeof fetch = async (url, init) => {
  if (!runtime) throw new Error("Local Worker unavailable");
  ++currentCalls;
  if (typeof init?.body !== "string" || init.method !== "POST")
    throw new Error("Expected JSON POST");
  const endpoint =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const response = await runtime.dispatchFetch(endpoint, {
    method: "POST",
    body: init.body,
    headers: Array.from(new Headers(init.headers).entries()),
    redirect: "error",
    ...(init.signal === undefined || init.signal === null
      ? {}
      : { signal: init.signal }),
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: Array.from(response.headers.entries()),
  });
};
function config(index: number) {
  return JSON.stringify({
    mode: "synthetic-local-only",
    endpoint: "http://127.0.0.1:8789",
    vaultId,
    deviceId: origins[index],
    paths: ["demo.md"],
    secretReference: "demo-native-secret",
    acknowledgement: "DISPOSABLE SYNTHETIC VAULT",
  });
}
async function command(plugin: ArtifactPlugin): Promise<string> {
  currentCalls = 0;
  const result = await plugin.syncNow();
  requestCounts.push(currentCalls);
  expect(currentCalls).toBeLessThanOrEqual(32);
  return result;
}
async function settle(plugin: ArtifactPlugin): Promise<void> {
  let result = await command(plugin);
  for (const _attempt of Array.from({ length: 16 })) {
    if (result === "settled" || result === "attention") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    result = await command(plugin);
  }
  expect(result).toBe("settled");
}
async function rest(body: object): Promise<unknown> {
  const response = await fetcher("http://127.0.0.1:8789/demo/v1/request", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens[2]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  return value;
}
function revisionOf(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("revision" in value) ||
    typeof value.revision !== "string"
  )
    throw new Error("Missing exact revision");
  return value.revision;
}
async function restUpdate(parent: string, content: string): Promise<void> {
  const body = {
    operation: "mutate",
    mutation: {
      kind: "update",
      path: "demo.md",
      parent: { kind: "revision", revision: parent },
      operationId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      content,
    },
  };
  let result = await rest(body);
  for (const _attempt of Array.from({ length: 16 })) {
    if (
      typeof result === "object" &&
      result !== null &&
      "kind" in result &&
      (result.kind === "committed" || result.kind === "conflict")
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    result = await rest(body);
  }
  expect(result).toMatchObject({ kind: "committed" });
}
beforeAll(async () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const output = join(directory, "worker.mjs");
  execFileSync(
    "bun",
    [
      "build",
      "apps/worker/src/demo/index.ts",
      "--target",
      "browser",
      "--format",
      "esm",
      "--outfile",
      output,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const registry = JSON.stringify({
    version: 1,
    credentials: tokens.map((token, index) => ({
      clientId: ids[index],
      name: `synthetic-${index}`,
      permissions: ["read", "write"],
      tokenDigest: createHash("sha256")
        .update(`obsidian-ai-bridge:client-credential:v1\0${token}`)
        .digest("hex"),
    })),
  });
  const configuration = JSON.stringify({
    mode: "synthetic-local-only",
    vaultId,
    paths: ["demo.md"],
    participants: ids.map((clientId, index) => ({
      clientId,
      origin: origins[index],
    })),
  });
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "synthetic-plugin-demo",
          type: "worker",
          compatibilityDate: "2026-09-09",
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: directory,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: readFileSync(output, "utf8"),
              },
            },
          },
          env: {
            DEMO_BUCKET: { type: "r2", name: "synthetic-plugin-demo" },
            DEMO_CONFIGURATION: { type: "text", value: configuration },
            DEMO_CREDENTIAL_REGISTRY: { type: "text", value: registry },
          },
        },
      },
    ],
  });
  await runtime.ready;
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe("synthetic plugin artifact", () => {
  it("has a distinct manifest and no release mirror activation code", () => {
    expect(JSON.parse(manifestText)).toMatchObject({
      id: "ai-bridge-synthetic-demo",
      minAppVersion: "1.13.0",
      isDesktopOnly: true,
    });
    expect(bundle).not.toContain("MirrorPluginSession");
    expect(bundle).not.toContain("mirror-device-state");
  });
  it("demonstrates two simulated new vaults A→B, B→A, REST, cold restart and conflict preservation through native local Worker/R2", async () => {
    const a = new SimApp(join(directory, "A"));
    const b = new SimApp(join(directory, "B"));
    a.secrets.set("demo-native-secret", tokens[0] ?? "");
    b.secrets.set("demo-native-secret", tokens[1] ?? "");
    const realmA = artifactRealm(bundle, a, fetcher);
    const realmB = artifactRealm(bundle, b, fetcher);
    const pluginA = realmA.load();
    let pluginB = realmB.load();
    expect(await command(pluginA)).toBe("attention");
    expect(currentCalls).toBe(0);
    pluginA.configure(config(0));
    pluginB.configure(config(1));
    expect(pluginA.statusText()).toBe("Ready");
    expect(pluginB.commands.has("sync-now")).toBe(true);
    expect(pluginB.buttons.some((button) => button.text === "Sync now")).toBe(
      true,
    );
    const fileA = await a.vault.create("demo.md", "# From A\r\nexact bytes\n");
    await settle(pluginA);
    await settle(pluginB);
    const fileB = b.vault.getAbstractFileByPath("demo.md");
    if (!(fileB instanceof FileNode)) throw new Error("B missing file");
    expect(await b.vault.read(fileB)).toBe(await a.vault.read(fileA));
    await b.vault.edit(fileB, "# From B\n");
    await settle(pluginB);
    await settle(pluginA);
    expect(await a.vault.read(fileA)).toBe("# From B\n");
    const head = await rest({ operation: "current", path: "demo.md" });
    await restUpdate(revisionOf(head), "# REST edit\n");
    await settle(pluginB);
    expect(await b.vault.read(fileB)).toBe("# REST edit\n");
    pluginB.unload();
    const coldApp = new SimApp(join(directory, "B"), b.vault);
    coldApp.secrets.set("demo-native-secret", tokens[1] ?? "");
    pluginB = artifactRealm(bundle, coldApp, fetcher).load();
    await settle(pluginB);
    expect(await b.vault.read(fileB)).toBe("# REST edit\n");
    expect(coldApp.loadLocalStorage(configKey)).toBe(config(1));
    await b.vault.edit(fileB, "# Keep local concurrent edit\n");
    await restUpdate(
      revisionOf(await rest({ operation: "current", path: "demo.md" })),
      "# Remote competing edit\n",
    );
    expect(await command(pluginB)).toBe("attention");
    expect(pluginB.statusText()).toBe("attention");
    expect(pluginB.statuses.at(-1)?.textContent).toBe(
      "Synthetic sync: attention",
    );
    expect(await b.vault.read(fileB)).toBe("# Keep local concurrent edit\n");
    const copies = b.vault
      .getAllLoadedFiles()
      .filter(
        (node) =>
          node instanceof FileNode &&
          node.path.startsWith("ai-bridge-conflicts/"),
      );
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    if (!(copy instanceof FileNode)) throw new Error("Missing copy");
    expect(await b.vault.read(copy)).toBe("# Remote competing edit\n");
    const ledgerKey = `ai-bridge:synthetic-demo:ledger:v1:${vaultId}:${origins[1]}`;
    const saved = coldApp.loadLocalStorage(ledgerKey);
    expect(typeof saved).toBe("string");
    expect(saved).not.toContain("Keep local");
    expect(saved).not.toContain(tokens[1]);
    pluginB.unload();
    pluginB = artifactRealm(bundle, coldApp, fetcher).load();
    expect(await command(pluginB)).toBe("attention");
    expect(await b.vault.read(copy)).toBe("# Remote competing edit\n");
    expect(
      b.vault
        .getAllLoadedFiles()
        .filter(
          (node) =>
            node instanceof FileNode &&
            node.path.startsWith("ai-bridge-conflicts/"),
        ),
    ).toHaveLength(1);
    expect(requestCounts.every((count) => count <= 32)).toBe(true);
    expect(a.vault.effects).toContain("process");
    expect(b.vault.effects).toContain("create");
    pluginA.unload();
    pluginB.unload();
  }, 180_000);
});
