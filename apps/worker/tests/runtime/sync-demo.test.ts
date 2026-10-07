import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeSyncCursor,
  SYNC_DEMO_ROUTE,
  syncDemoRequestSchema,
  syncDemoResponseSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "m8-local-api-"));
const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const clientId = "22222222-2222-4222-8222-222222222222";
const origin = "33333333-3333-4333-8333-333333333333";
const token = "synthetic-workerd-m8-token";
const requestBody = {
  operation: "mutate",
  mutation: {
    kind: "create",
    path: "demo.md",
    parent: { kind: "never_seen" },
    operationId: "44444444-4444-4444-8444-444444444444",
    revision: "55555555-5555-4555-8555-555555555555",
    content: "# Native\r\nExact Markdown\n",
  },
};
let runtime: Miniflare | undefined;
let maximumCalls = 0;

beforeAll(async () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const entry = new URL("./fixtures/sync-demo.worker.ts", import.meta.url)
    .pathname;
  const output = join(directory, "worker.mjs");
  execFileSync(
    "bun",
    [
      "build",
      entry,
      "--target",
      "browser",
      "--format",
      "esm",
      "--outfile",
      output,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const registry = serializeCredentialRegistry({
    version: 1,
    credentials: [
      {
        clientId,
        name: "synthetic",
        permissions: ["read", "write"],
        tokenDigest: await digestCredentialToken(token),
      },
    ],
  });
  const configuration = JSON.stringify({
    mode: "synthetic-local-only",
    vaultId,
    paths: ["demo.md"],
    participants: [
      { clientId, origin },
      {
        clientId: "66666666-6666-4666-8666-666666666666",
        origin: "77777777-7777-4777-8777-777777777777",
      },
      {
        clientId: "88888888-8888-4888-8888-888888888888",
        origin: "99999999-9999-4999-8999-999999999999",
      },
    ],
  });
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "m8-local-api",
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
            DEMO_BUCKET: { type: "r2", name: "m8-local-api" },
            DEMO_CONFIGURATION: { type: "text", value: configuration },
            DEMO_CREDENTIAL_REGISTRY: { type: "text", value: registry },
          },
        },
      },
    ],
  });
  await runtime.ready;
});
afterAll(async () => {
  await runtime?.dispose();
  rmSync(directory, { recursive: true, force: true });
});

async function post(body: object) {
  if (!runtime) throw new Error("Native runtime unavailable");
  const response = await runtime.dispatchFetch(
    `http://127.0.0.1${SYNC_DEMO_ROUTE}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Test-Legacy")).toBe("unchanged-v2");
  maximumCalls = Math.max(
    maximumCalls,
    Number(response.headers.get("Test-Store-Calls")),
  );
  expect(maximumCalls).toBeLessThanOrEqual(400);
  if (syncDemoRequestSchema.parse(body).operation === "mutate") {
    expect(
      Number(response.headers.get("Test-Store-Calls")),
    ).toBeLessThanOrEqual(69);
  }
  return syncDemoResponseSchema.parse(await response.json());
}

async function settle(body: object) {
  let result = await post(body);
  for (const _ of Array.from({ length: 40 })) {
    if (
      result.kind === "committed" ||
      (result.kind === "error" && result.code === "stale_revision")
    )
      return result;
    expect(result).toMatchObject({ kind: "error" });
    result = await post(body);
  }
  throw new Error("Native mutation never reached a verified outcome");
}

describe("actual isolated demo entrypoint with native local R2", () => {
  it("creates, replays, updates and refuses a stale REST parent in one observable revision/feed domain", async () => {
    expect(await post({ operation: "current", path: "demo.md" })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    const created = await settle(requestBody);
    expect(created).toMatchObject({
      kind: "committed",
      revision: requestBody.mutation.revision,
    });
    expect(await post(requestBody)).toEqual(created);
    expect(
      await post({
        operation: "version",
        revision: requestBody.mutation.revision,
      }),
    ).toMatchObject({
      kind: "present",
      version: { content: requestBody.mutation.content, origin },
    });
    const updatedBody = {
      operation: "mutate",
      mutation: {
        ...requestBody.mutation,
        kind: "update",
        parent: { kind: "revision", revision: requestBody.mutation.revision },
        content: "# API successor\n",
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    };
    expect(await settle(updatedBody)).toMatchObject({
      kind: "committed",
      revision: updatedBody.mutation.revision,
    });
    const stale = {
      ...updatedBody,
      mutation: {
        ...updatedBody.mutation,
        content: "must not win",
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        revision: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    };
    expect(await settle(stale)).toEqual({
      kind: "error",
      code: "stale_revision",
    });
    expect(
      await post({
        operation: "version",
        revision: updatedBody.mutation.revision,
      }),
    ).toMatchObject({
      kind: "present",
      version: { content: updatedBody.mutation.content },
    });
    const cursor = encodeSyncCursor({
      protocolMajor: 1,
      vaultId,
      laneSequences: Array.from({ length: 64 }, () =>
        syncSequenceSchema.parse("00000000000000000000"),
      ),
      nextLane: 0,
    });
    const page = await post({ operation: "changes", cursor });
    expect(page).toMatchObject({
      kind: "page",
      events: [
        {
          kind: "changed",
          result: { revision: requestBody.mutation.revision },
        },
        {
          kind: "changed",
          result: { revision: updatedBody.mutation.revision },
        },
        { kind: "aborted", reason: "stale_revision" },
      ],
    });
  });
});
