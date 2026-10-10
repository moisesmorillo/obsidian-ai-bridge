import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactPlugin,
  acceleratedArtifactClock,
  artifactRealm,
  FileNode,
  SimApp,
} from "@obsidian-plugin-tests/artifact/demo-host";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

const ledgerSnapshotSchema = z.object({
  cursor: z.string().min(1),
  entries: z.array(
    z.object({
      base: z
        .object({ revision: z.string(), contentSha256: z.string() })
        .nullable(),
      work: z.unknown(),
    }),
  ),
});
const cursorSnapshotSchema = z.object({
  protocolMajor: z.literal(1),
  vaultId: z.string(),
  laneSequences: z.array(z.string()).length(64),
  nextLane: z.number(),
});

function cursorSnapshot(value: string) {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  expect(Buffer.from(decoded, "utf8").toString("base64url")).toBe(value);
  return cursorSnapshotSchema.parse(JSON.parse(decoded));
}

describe.each(["local", "remote"] as const)(
  "%s transport artifact",
  (profile) => {
    const endpoint =
      profile === "local"
        ? "http://127.0.0.1:8789"
        : "https://synthetic.example.test";
    const mode =
      profile === "local" ? "synthetic-local-only" : "synthetic-remote-only";
    const experimentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let restTicket = 0;
    const bundle = readFileSync(
      new URL(
        `../../dist/${profile === "local" ? "demo" : "remote"}-plugin/main.js`,
        import.meta.url,
      ),
      "utf8",
    );
    const manifestText = readFileSync(
      new URL(
        `../../dist/${profile === "local" ? "demo" : "remote"}-plugin/manifest.json`,
        import.meta.url,
      ),
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
    const configKey =
      profile === "local"
        ? "ai-bridge:synthetic-demo:configuration:v1"
        : "ai-bridge:synthetic-remote:configuration:v1";
    let runtime: Miniflare | undefined;
    const requestCounts: number[] = [];
    const requestTrace: string[] = [];
    const clientRequests = new Map<string, number>();
    let currentCalls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (!runtime) throw new Error("Local Worker unavailable");
      ++currentCalls;
      if (typeof init?.body !== "string" || init.method !== "POST")
        throw new Error("Expected JSON POST");
      const authorization = new Headers(init.headers).get("Authorization");
      const participant = tokens.find(
        (token) => authorization === `Bearer ${token}`,
      );
      if (participant !== undefined)
        clientRequests.set(
          participant,
          (clientRequests.get(participant) ?? 0) + 1,
        );
      const endpoint =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const request: unknown = JSON.parse(init.body);
      const operation =
        typeof request === "object" &&
        request !== null &&
        "operation" in request
          ? request.operation
          : "invalid";
      const response = await runtime.dispatchFetch(endpoint, {
        method: "POST",
        body: init.body,
        headers: Array.from(new Headers(init.headers).entries()),
        redirect: "error",
        ...(init.signal === undefined || init.signal === null
          ? {}
          : { signal: init.signal }),
      });
      const bytes = await response.arrayBuffer();
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const kind =
        typeof result === "object" && result !== null && "kind" in result
          ? result.kind
          : "invalid";
      const code =
        typeof result === "object" && result !== null && "code" in result
          ? result.code
          : "";
      requestTrace.push(
        `${String(operation)}:${response.status}:${String(kind)}:${String(code)}`,
      );
      return new Response(bytes, {
        status: response.status,
        headers: Array.from(response.headers.entries()),
      });
    };
    function config(index: number) {
      return JSON.stringify({
        mode,
        endpoint,
        ...(profile === "remote" ? { experimentId } : {}),
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
      const response = await fetcher(`${endpoint}/demo/v1/request`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens[2]}`,
          "Content-Type": "application/json",
          ...(profile === "remote"
            ? {
                "X-AI-Bridge-Remote-Ticket": String(restTicket++),
                "X-AI-Bridge-Demo-Vault-Id": vaultId,
                "X-AI-Bridge-Demo-Origin": origins[2] ?? "",
              }
            : {}),
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
    beforeAll(() => {
      const root = new URL("../../../../", import.meta.url).pathname;
      const output = join(directory, "worker.mjs");
      execFileSync(
        "bun",
        [
          "build",
          `apps/worker/src/${profile === "local" ? "demo" : "remote"}/index.ts`,
          "--target",
          "browser",
          "--format",
          "esm",
          "--outfile",
          output,
        ],
        { cwd: root, stdio: "pipe" },
      );
    }, 30_000);
    beforeEach(async () => {
      const output = join(directory, "worker.mjs");
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
        mode,
        ...(profile === "remote"
          ? {
              endpoint,
              experimentId,
              enabled: true,
              startsAtEpochMs: Date.now() - 1000,
              expiresAtEpochMs: Date.now() + 3_500_000,
            }
          : {}),
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
                [profile === "local" ? "DEMO_BUCKET" : "REMOTE_BUCKET"]: {
                  type: "r2",
                  name: "synthetic-plugin-demo",
                },
                [profile === "local"
                  ? "DEMO_CONFIGURATION"
                  : "REMOTE_CONFIGURATION"]: {
                  type: "text",
                  value: configuration,
                },
                [profile === "local"
                  ? "DEMO_CREDENTIAL_REGISTRY"
                  : "REMOTE_CREDENTIAL_REGISTRY"]: {
                  type: "text",
                  value: registry,
                },
              },
            },
          },
        ],
      });
      await runtime.ready;
    }, 30_000);
    afterEach(async () => {
      await runtime?.dispose();
      runtime = undefined;
    });
    afterAll(async () => {
      rmSync(directory, { recursive: true, force: true });
    });

    describe("synthetic plugin artifact", () => {
      it("has a distinct manifest and no release mirror activation code", () => {
        expect(JSON.parse(manifestText)).toMatchObject({
          id:
            profile === "local"
              ? "ai-bridge-synthetic-demo"
              : "ai-bridge-synthetic-remote",
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
        expect(
          pluginB.buttons.some((button) => button.text === "Sync now"),
        ).toBe(true);
        const fileA = await a.vault.create(
          "demo.md",
          "# From A\r\nexact bytes\n",
        );
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
        expect(await b.vault.read(fileB)).toBe(
          "# Keep local concurrent edit\n",
        );
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
        const ledgerKey =
          profile === "local"
            ? `ai-bridge:synthetic-demo:ledger:v1:${vaultId}:${origins[1]}`
            : `ai-bridge:synthetic-remote:ledger:v1:${experimentId}:${vaultId}:${origins[1]}`;
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
      it.runIf(profile === "remote")(
        "automatically reconciles two isolated host instances without Sync now and preserves a competing edit",
        async () => {
          currentCalls = 0;
          requestTrace.length = 0;
          clientRequests.clear();
          restTicket = 0;
          const a = new SimApp(join(directory, "automatic-A"));
          const b = new SimApp(join(directory, "automatic-B"));
          a.secrets.set("demo-native-secret", tokens[0] ?? "");
          b.secrets.set("demo-native-secret", tokens[1] ?? "");
          const ledgerKey = (index: number) =>
            `ai-bridge:synthetic-remote:ledger:v1:${experimentId}:${vaultId}:${origins[index]}`;
          const ledger = (app: SimApp, index: number) => {
            const saved = app.loadLocalStorage(ledgerKey(index));
            if (typeof saved !== "string") return null;
            return ledgerSnapshotSchema.parse(JSON.parse(saved));
          };
          const waitFor = async (
            predicate: () => boolean | Promise<boolean>,
            label: string,
            timeoutMs = 30_000,
          ) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (await predicate()) return;
              await new Promise<void>((resolve) => setTimeout(resolve, 200));
            }
            expect(await predicate(), label).toBe(true);
          };
          const digest = (content: string) =>
            createHash("sha256").update(content).digest("hex");
          const callsFor = (index: number) =>
            clientRequests.get(tokens[index] ?? "") ?? 0;
          const clockA = acceleratedArtifactClock();
          const clockB = acceleratedArtifactClock();
          let pluginA = artifactRealm(bundle, a, fetcher, clockA).load();
          let pluginB = artifactRealm(bundle, b, fetcher, clockB).load();
          pluginA.configure(config(0));
          pluginB.configure(config(1));
          expect(pluginA.setAutomaticSync(true)).toBe(true);
          expect(pluginA.automaticSyncEnabled()).toBe(true);
          const aText = "# Automatic A\r\nexact bytes\n";
          const fileA = await a.vault.create("demo.md", aText);
          try {
            await waitFor(
              () => (ledger(a, 0)?.entries[0]?.base ?? null) !== null,
              "A persisted its first exact base automatically",
              120_000,
            );
          } catch (error) {
            throw new Error(
              `A state=${pluginA.statusText()} calls=${currentCalls} work=${JSON.stringify(ledger(a, 0)?.entries[0]?.work)} trace=${requestTrace.join(",")}`,
              { cause: error },
            );
          }
          const aBase = ledger(a, 0)?.entries[0]?.base;
          expect(aBase?.contentSha256).toBe(digest(aText));
          const afterA = currentCalls;
          expect(afterA).toBeLessThanOrEqual(32);

          expect(pluginB.setAutomaticSync(true)).toBe(true);
          await waitFor(
            () => b.vault.getAbstractFileByPath("demo.md") instanceof FileNode,
            "B received A without Sync now",
          );
          const fileB = b.vault.getAbstractFileByPath("demo.md");
          if (!(fileB instanceof FileNode)) throw new Error("B missing file");
          expect(await b.vault.read(fileB)).toBe(aText);
          expect(ledger(b, 1)?.entries[0]?.base).toEqual(aBase);
          expect(currentCalls - afterA).toBeLessThanOrEqual(32);

          const bText = "# Automatic B\n";
          await b.vault.edit(fileB, bText);
          await waitFor(
            () =>
              ledger(b, 1)?.entries[0]?.base?.contentSha256 === digest(bText),
            "B committed its saved edit automatically",
          );
          const bBase = ledger(b, 1)?.entries[0]?.base;
          pluginA.unload();
          pluginA = artifactRealm(bundle, a, fetcher, clockA).load();
          expect(pluginA.automaticSyncEnabled()).toBe(true);
          await waitFor(
            async () => (await a.vault.read(fileA)) === bText,
            "A received B after targeted reload without Sync now",
          );
          expect(ledger(a, 0)?.entries[0]?.base).toEqual(bBase);

          const beforeRest = currentCalls;
          const restHead = await rest({
            operation: "current",
            path: "demo.md",
          });
          expect(revisionOf(restHead)).toBe(bBase?.revision);
          const restText = "# REST automatic poll\n";
          await restUpdate(revisionOf(restHead), restText);
          const remoteHead = await rest({
            operation: "current",
            path: "demo.md",
          });
          const restRevision = revisionOf(remoteHead);
          await waitFor(
            async () => (await b.vault.read(fileB)) === restText,
            "B received REST on its scheduled remote poll",
            75_000,
          );
          const beforeReload = ledger(b, 1);
          expect(beforeReload?.entries[0]?.base).toEqual({
            revision: restRevision,
            contentSha256: digest(restText),
          });
          expect(beforeReload?.cursor).toBeTruthy();
          expect(currentCalls - beforeRest).toBeLessThanOrEqual(128);

          pluginB.unload();
          const coldB = new SimApp(join(directory, "automatic-B"), b.vault);
          coldB.secrets.set("demo-native-secret", tokens[1] ?? "");
          pluginB = artifactRealm(bundle, coldB, fetcher, clockB).load();
          expect(pluginB.automaticSyncEnabled()).toBe(true);
          await waitFor(
            () => pluginB.statusText() === "settled",
            "targeted reload rehydrated a settled automatic pass",
          );
          expect(ledger(coldB, 1)?.entries[0]?.base).toEqual(
            beforeReload?.entries[0]?.base,
          );
          const beforeCursor = beforeReload?.cursor;
          const afterCursor = ledger(coldB, 1)?.cursor;
          if (beforeCursor === undefined || afterCursor === undefined)
            throw new Error("Missing reload checkpoint");
          const beforeVector = cursorSnapshot(beforeCursor);
          const afterVector = cursorSnapshot(afterCursor);
          expect(afterVector.vaultId).toBe(beforeVector.vaultId);
          expect(
            afterVector.laneSequences.every((sequence, index) => {
              const previous = beforeVector.laneSequences[index];
              return previous !== undefined && sequence >= previous;
            }),
          ).toBe(true);

          expect(pluginA.setAutomaticSync(false)).toBe(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
          const aCallsAfterDisable = callsFor(0);
          await new Promise<void>((resolve) => setTimeout(resolve, 1_800));
          expect(callsFor(0)).toBe(aCallsAfterDisable);

          pluginB.unload();
          const conflictCursor = ledger(coldB, 1)?.cursor;
          const competingText = "# Remote competing edit\n";
          await restUpdate(restRevision, competingText);
          const localText = "# Keep local concurrent edit\n";
          await b.vault.edit(fileB, localText);
          pluginB = artifactRealm(bundle, coldB, fetcher, clockB).load();
          await waitFor(
            () => pluginB.statusText() === "attention",
            "stale local base stopped automatic sync",
          );
          expect(await b.vault.read(fileB)).toBe(localText);
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
          expect(await b.vault.read(copy)).toBe(competingText);
          expect(ledger(coldB, 1)?.entries[0]?.base).toEqual(
            beforeReload?.entries[0]?.base,
          );
          expect(ledger(coldB, 1)?.cursor).toBe(conflictCursor);
          expect(currentCalls).toBeLessThanOrEqual(300);
          process.stdout.write(
            `M9 isolated artifact requests ${JSON.stringify({
              total: currentCalls,
              a: callsFor(0),
              b: callsFor(1),
              rest: callsFor(2),
            })}\n`,
          );
          pluginA.unload();
          pluginB.unload();
        },
        360_000,
      );
    });
  },
);
