import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashSyncDemoContent,
  SyncDemoClient,
  type SyncDemoClientBinding,
  type SyncDemoLocal,
  type SyncDemoStringStorage,
} from "@obsidian-ai-bridge/core";
import {
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { SyncDemoFetchRemote } from "@obsidian-plugin/demo/sync-demo-fetch";
import { SyncDemoLedgerRepository } from "@obsidian-plugin/demo/sync-demo-ledger";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import demo from "@worker/demo/index";
import type {
  R2ConditionalBucketPort,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("22222222-2222-4222-8222-222222222222");
const path = syncNotePathSchema.parse("demo.md");
const participants = [
  {
    clientId: "11111111-1111-4111-8111-111111111111",
    origin: syncDeviceIdSchema.parse("33333333-3333-4333-8333-333333333333"),
    token: "synthetic-A-only",
  },
  {
    clientId: "44444444-4444-4444-8444-444444444444",
    origin: syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555"),
    token: "synthetic-B-only",
  },
  {
    clientId: "66666666-6666-4666-8666-666666666666",
    origin: syncDeviceIdSchema.parse("77777777-7777-4777-8777-777777777777"),
    token: "synthetic-REST-only",
  },
];

async function lab(directory: string) {
  let now = 2_000_000_000_000;
  let generation = 0;
  const objects = new Map<string, R2ConditionalStoredObject>();
  const bucket: R2ConditionalBucketPort = {
    get: async (key) => objects.get(key) ?? null,
    list: async () => ({ objects: [], truncated: false }),
    put: async (key, content, options) => {
      const prior = objects.get(key);
      if (
        options.onlyIf instanceof Headers
          ? options.onlyIf.get("If-None-Match") !== "*" || prior !== undefined
          : prior?.etag !== options.onlyIf.etagMatches
      )
        return null;
      generation += 1;
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content.slice();
      const object: R2ConditionalStoredObject = {
        key,
        size: bytes.byteLength,
        etag: `synthetic-${generation}`,
        uploaded: new Date(now),
        arrayBuffer: async () => bytes.slice().buffer,
      };
      objects.set(key, object);
      return object;
    },
  };
  const registry = serializeCredentialRegistry({
    version: 1,
    credentials: await Promise.all(
      participants.map(async (participant, index) => ({
        clientId: participant.clientId,
        name: `synthetic-${index}`,
        permissions: ["read" as const, "write" as const],
        tokenDigest: await digestCredentialToken(participant.token),
      })),
    ),
  });
  const configuration = JSON.stringify({
    mode: "synthetic-local-only",
    vaultId,
    paths: [path],
    participants: participants.map(({ clientId, origin }) => ({
      clientId,
      origin,
    })),
  });
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    now += 5000;
    calls += 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      return await demo.fetch(new Request(input, init), {
        DEMO_BUCKET: bucket,
        DEMO_CONFIGURATION: configuration,
        DEMO_CREDENTIAL_REGISTRY: registry,
      });
    } finally {
      clock.mockRestore();
    }
  };
  function binding(index: number): SyncDemoClientBinding {
    const participant = participants[index];
    if (!participant) throw new Error("Missing synthetic participant");
    return { vaultId, deviceId: participant.origin, paths: [path] };
  }
  function remote(
    index: number,
    intended = binding(index),
    secret = async () => participants[index]?.token ?? null,
  ) {
    return new SyncDemoFetchRemote(
      "http://127.0.0.1:8789",
      intended,
      secret,
      fetcher,
      undefined,
      undefined,
      () => now,
    );
  }
  function client(index: number, initial: string | null) {
    let content = initial;
    const copies = new Map<string, string>();
    const storagePath = join(directory, `device-${index}.json`);
    const storage: SyncDemoStringStorage = {
      read: async () => {
        try {
          return await readFile(storagePath, "utf8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        }
      },
      write: async (value) => {
        await writeFile(storagePath, value, "utf8");
      },
    };
    const host: SyncDemoLocal = {
      observe: async () =>
        content === null ? { kind: "absent" } : { kind: "live", content },
      apply: async (_path, expected, next) => {
        if (content !== expected) return "refused";
        content = next;
        return "applied";
      },
      preserve: async (_path, revision, next) => {
        if (!copies.has(revision)) copies.set(revision, next);
      },
      preserved: async (_path, revision) => copies.get(revision) ?? null,
    };
    let repository = new SyncDemoLedgerRepository(storage, binding(index));
    let coordinator = new SyncDemoClient(repository, host, remote(index), {
      binding: binding(index),
      now: () => now,
      operationId: () => syncOperationIdSchema.parse(crypto.randomUUID()),
      revision: () => syncRevisionSchema.parse(crypto.randomUUID()),
    });
    return {
      host,
      content: () => content,
      edit: (next: string) => {
        content = next;
      },
      copies,
      ledger: () => repository.load(),
      restart: () => {
        repository = new SyncDemoLedgerRepository(storage, binding(index));
        coordinator = new SyncDemoClient(repository, host, remote(index), {
          binding: binding(index),
          now: () => now,
          operationId: () => syncOperationIdSchema.parse(crypto.randomUUID()),
          revision: () => syncRevisionSchema.parse(crypto.randomUUID()),
        });
      },
      sync: async () => {
        now += 5000;
        const before = calls;
        const outcome = await coordinator.syncNow();
        expect(calls - before).toBeLessThanOrEqual(32);
        return outcome;
      },
    };
  }
  return {
    client,
    remote,
    binding,
    storedObjectCount: () => objects.size,
    tick: () => {
      now += 5000;
    },
  };
}

async function settle(client: { sync(): Promise<string> }) {
  let outcome = "pending";
  for (const _ of Array.from({ length: 25 })) {
    outcome = await client.sync();
    if (outcome !== "pending") break;
  }
  expect(outcome).toBe("settled");
}

describe("two durable clients over the actual local REST composition", () => {
  it.each(["vault", "participant", "credential_rotation"] as const)(
    "refuses mismatched intended %s before admitting a mutation",
    async (mismatch) => {
      const directory = await mkdtemp(
        join(tmpdir(), "ai-bridge-synthetic-binding-"),
      );
      try {
        const f = await lab(directory);
        const intended = {
          ...f.binding(0),
          ...(mismatch === "vault"
            ? {
                vaultId: syncVaultIdSchema.parse(
                  "88888888-8888-4888-8888-888888888888",
                ),
              }
            : mismatch === "participant"
              ? { deviceId: f.binding(1).deviceId }
              : {}),
        };
        let secretReads = 0;
        const wrong = f.remote(0, intended, async () => {
          const selected =
            mismatch === "credential_rotation" && secretReads > 0 ? 1 : 0;
          secretReads += 1;
          return participants[selected]?.token ?? null;
        });
        if (mismatch === "credential_rotation") await wrong.current(path);
        const content = "# Synthetic mismatched binding\n";
        const request = {
          kind: "create" as const,
          vaultId: intended.vaultId,
          path,
          origin: intended.deviceId,
          parent: { kind: "never_seen" as const },
          operationId: syncOperationIdSchema.parse(crypto.randomUUID()),
          revision: syncRevisionSchema.parse(crypto.randomUUID()),
          contentSha256: await hashSyncDemoContent(content),
          content,
          mediaType: "text/markdown" as const,
        };
        let result = await wrong.mutate(request);
        for (const _ of Array.from({ length: 25 })) {
          if (
            result.kind === "committed" ||
            (result.kind === "error" && result.code === "invalid_input")
          )
            break;
          f.tick();
          result = await wrong.mutate(request);
        }
        expect(result).toMatchObject({ kind: "error", code: "invalid_input" });
        expect(f.storedObjectCount()).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("converges both ways, reloads on-disk bases and preserves a REST-origin concurrent edit", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ai-bridge-synthetic-client-"),
    );
    try {
      const f = await lab(directory);
      const a = f.client(0, "# A synthetic\r\n");
      const b = f.client(1, null);
      await settle(a);
      await settle(b);
      expect(b.content()).toBe("# A synthetic\r\n");
      b.edit("# B synthetic\n");
      await settle(b);
      await settle(a);
      expect(a.content()).toBe("# B synthetic\n");
      a.restart();
      b.restart();
      expect(await a.sync()).toBe("settled");
      expect(await b.sync()).toBe("settled");
      const rest = f.remote(2);
      async function restEdit(content: string) {
        rest.beginPass();
        const current = await rest.current(path);
        if (current.kind !== "live")
          throw new Error("Missing current synthetic revision");
        const mutation = {
          kind: "update" as const,
          vaultId,
          path,
          origin: f.binding(2).deviceId,
          parent: { kind: "revision" as const, revision: current.revision },
          operationId: syncOperationIdSchema.parse(crypto.randomUUID()),
          revision: syncRevisionSchema.parse(crypto.randomUUID()),
          contentSha256: await hashSyncDemoContent(content),
          content,
          mediaType: "text/markdown" as const,
        };
        let outcome = await rest.mutate(mutation);
        for (const _ of Array.from({ length: 25 })) {
          if (outcome.kind === "committed") break;
          f.tick();
          outcome = await rest.mutate(mutation);
        }
        expect(outcome.kind).toBe("committed");
        return mutation.revision;
      }
      await restEdit("# REST clean synthetic\n");
      await settle(b);
      expect(b.content()).toBe("# REST clean synthetic\n");
      b.edit("# B concurrent synthetic\n");
      const competing = await restEdit("# REST competing synthetic\n");
      expect(await b.sync()).toBe("attention");
      expect(b.content()).toBe("# B concurrent synthetic\n");
      expect(b.copies.get(competing)).toBe("# REST competing synthetic\n");
      b.restart();
      expect(await b.sync()).toBe("attention");
      expect(b.content()).toBe("# B concurrent synthetic\n");
      const ledger = await b.ledger();
      expect(ledger.kind).toBe("ready");
      if (ledger.kind === "ready")
        expect(ledger.ledger.entries[0]?.work).toMatchObject({
          kind: "conflict",
          preserved: true,
        });
      const persisted = await readFile(
        join(directory, "device-1.json"),
        "utf8",
      );
      expect(persisted).not.toContain("synthetic-token");
      expect(persisted).not.toContain('"content":');
      expect(persisted).not.toContain("# B");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
