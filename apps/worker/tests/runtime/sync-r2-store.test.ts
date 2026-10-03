import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const buildDirectory = mkdtempSync(join(tmpdir(), "m7-composed-workerd-"));
let runtime: Miniflare | undefined;

beforeAll(async () => {
  const entry = new URL("./fixtures/sync-r2-store.worker.ts", import.meta.url)
    .pathname;
  const output = join(buildDirectory, "worker.mjs");
  const projectRoot = new URL("../../../../", import.meta.url).pathname;
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
    {
      cwd: projectRoot,
      stdio: "pipe",
    },
  );
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "private-composed-sync-store",
          type: "worker",
          compatibilityDate: "2026-09-09",
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: buildDirectory,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: readFileSync(output, "utf8"),
              },
            },
          },
          env: { BUCKET: { type: "r2", name: "private-composed-sync-store" } },
        },
      },
    ],
  });
  await runtime.ready;
});

afterAll(async () => {
  await runtime?.dispose();
  rmSync(buildDirectory, { recursive: true, force: true });
});

describe("composed private SyncStore inside pinned workerd", () => {
  it("finishes an empty v2 scan with native in-isolate predicates and preserves a legacy object", async () => {
    if (!runtime) throw new Error("Local workerd was not ready");
    const response = await runtime.dispatchFetch(
      "http://private-composed-sync-store.test/verify",
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    const result = z
      .object({
        result: z.object({
          kind: z.literal("complete"),
          entryCount: z.literal(0),
          chunkCount: z.literal(1),
        }),
        page: z.object({
          kind: z.literal("complete"),
          summaries: z.tuple([]),
          final: z.literal(true),
          nextCursor: z.null(),
        }),
        invocations: z.number().int().min(2).max(49),
        legacyText: z.literal("unchanged-legacy-object"),
      })
      .parse(await response.json());
    expect(result.result.kind).toBe("complete");
  });
});
