import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";

it("keeps the tracked Worker closed and explicitly arms only the approved workers.dev deployment overlay", () => {
  const template = z
    .object({
      workers_dev: z.boolean(),
      preview_urls: z.boolean(),
      routes: z.array(z.string()),
      main: z.string(),
      r2_buckets: z.array(
        z.object({
          binding: z.literal("REMOTE_BUCKET"),
          bucket_name: z.string(),
          remote: z.boolean(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("../../../worker/wrangler.remote.jsonc", import.meta.url),
          "utf8",
        ),
      ),
    );
  expect(template.workers_dev).toBe(false);
  expect(template.preview_urls).toBe(false);
  expect(template.routes).toEqual([]);
  expect(template.main).toBe("src/remote/index.ts");
  const recipe = readFileSync(
    new URL("../../../../docs/remote-sync-lab.md", import.meta.url),
    "utf8",
  );
  const block = recipe.match(
    /### Isolated deployment configuration[\s\S]*?```json\n([\s\S]*?)\n```/,
  )?.[1];
  expect(
    block,
    "SEC-01: recipe must explicitly override the closed template",
  ).toBeDefined();
  if (block === undefined)
    throw new Error("Missing approved deployment overlay.");
  const overlay = z
    .object({
      account_id: z.literal("<owner-supplied-ID>"),
      name: z.literal("ai-bridge-m8-remote-synthetic-20261009a"),
      main: z.literal(
        "<absolute-reviewed-repo>/apps/worker/src/remote/index.ts",
      ),
      workers_dev: z.literal(true),
      preview_urls: z.literal(false),
      routes: z.array(z.string()).max(0),
      r2_buckets: z
        .array(
          z
            .object({
              binding: z.literal("REMOTE_BUCKET"),
              bucket_name: z.literal("ai-bridge-m8-remote-synthetic-20261009a"),
              remote: z.literal(false),
            })
            .strict(),
        )
        .length(1),
    })
    .strict()
    .parse(JSON.parse(block));
  const deployment = { ...template, ...overlay };
  expect(deployment.workers_dev).toBe(true);
  expect(deployment.preview_urls).toBe(false);
  expect(deployment.routes).toEqual([]);
  expect(deployment.r2_buckets).toHaveLength(1);
  expect(recipe).toContain(
    '--config "$LAB_CONFIG" --tsconfig "$REVIEWED_REPO/tsconfig.json"',
  );
  expect(recipe).toContain("PR merge is not operational approval");
});
