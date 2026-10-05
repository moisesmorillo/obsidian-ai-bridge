import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalInventoryProfile } from "@worker-tests/runtime/fixtures/inventory-profile-driver";
import { hostResourcesSchema } from "@worker-tests/runtime/fixtures/inventory-profile-host-resources";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it.each([
  { removed: "checkpoint.json", completed: false },
  { removed: "r2-state", completed: false },
  { removed: "replacement", completed: false },
  { removed: "checkpoint.json", completed: true },
  { removed: "r2-state", completed: true },
  { removed: "replacement", completed: true },
  { removed: "pair.json", completed: true },
])(
  "refuses unpaired artifacts ($removed, completed=$completed)",
  async ({ removed, completed }) => {
    const directory = mkdtempSync(join(tmpdir(), "m7-profile-pair-"));
    try {
      await runLocalInventoryProfile({
        directory,
        headCount: 1,
        ...(completed ? {} : { maxRequests: 1 }),
      });
      const worker = readFileSync(join(directory, "worker.mjs"));
      const hostResources = readFileSync(
        join(directory, "host-resources.json"),
      );
      const path = join(
        directory,
        removed === "replacement" ? "r2-state" : removed,
      );
      rmSync(path, { recursive: true, force: true });
      if (removed === "replacement") mkdirSync(path);
      await expect(
        runLocalInventoryProfile({ directory, headCount: 1 }),
      ).rejects.toThrow("Persistence pair");
      expect(readFileSync(join(directory, "worker.mjs"))).toEqual(worker);
      expect(readFileSync(join(directory, "host-resources.json"))).toEqual(
        hostResources,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it.each(["after_dispatch", "after_trace"] as const)(
  "preserves accounting certainty across %s interruption",
  async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "m7-profile-lost-reply-"));
    try {
      await expect(
        runLocalInventoryProfile({ directory, headCount: 1 }, (point) => {
          if (point === boundary)
            throw new Error("Injected acknowledgement interruption.");
        }),
      ).rejects.toThrow("Injected acknowledgement interruption");
      const resumed = await runLocalInventoryProfile({
        directory,
        headCount: 1,
      });
      expect(resumed).toMatchObject({
        completed: true,
        accountingComplete: boundary === "after_trace",
        unresolvedRequests: boundary === "after_trace" ? 0 : 1,
        unobservedCallsUpperBound: boundary === "after_trace" ? 0 : 400,
        callsScope: "observed-replies-only",
      });
      expect(resumed.requests).toBe(
        resumed.observedReplies + resumed.unresolvedRequests,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it("reports physical seed calls without running an inventory inside that request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "m7-profile-red-"));
  const output = join(directory, "worker.mjs");
  const root = new URL("../../../../", import.meta.url).pathname;
  execFileSync(
    "bun",
    [
      "build",
      "apps/worker/tests/runtime/fixtures/inventory-profile.worker.ts",
      "--target",
      "browser",
      "--format",
      "esm",
      "--outfile",
      output,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "inventory-profile",
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
          env: { BUCKET: { type: "r2", name: "inventory-profile" } },
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch(
      "http://inventory-profile.test/profile",
      {
        method: "POST",
        body: JSON.stringify({ action: "seed", headCount: 1, offset: 0 }),
      },
    );
    expect(await response.json()).toMatchObject({
      action: "seed",
      nextOffset: 1,
      metrics: {
        calls: { get: 2, put: 2, list: 0 },
        cpu: "unavailable",
        memory: "unavailable",
      },
    });
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it.each([0, 1])(
  "completes %i native heads through separate real-clock requests and full evidence",
  async (headCount) => {
    const directory = mkdtempSync(join(tmpdir(), "m7-profile-native-"));
    try {
      const report = await runLocalInventoryProfile({ directory, headCount });
      expect(report).toMatchObject({
        completed: true,
        headCount,
        verifiedSummaries: headCount,
        cpu: "unavailable",
        isolateMemory: "unavailable",
      });
      expect(report.maxCallsPerRequest).toBeLessThanOrEqual(400);
      expect(report.requests).toBeGreaterThan(1);
      expect(report.calls.list).toBeGreaterThanOrEqual(1);
      expect(report.handle?.entryCount).toBe(headCount);
      const resources = hostResourcesSchema.parse(
        JSON.parse(
          readFileSync(join(directory, "host-resources.json"), "utf8"),
        ),
      );
      expect(resources).toMatchObject({
        scope: "node-host-process-only",
        recipeSha256: report.recipeSha256,
        sealed: true,
        traversalCompleted: true,
        isolateCpu: "unavailable",
        isolateMemory: "unavailable",
      });
      expect(resources.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "verify_pair", outcome: "ok" }),
          expect.objectContaining({ phase: "summarize_trace", outcome: "ok" }),
          expect.objectContaining({ phase: "seal_pair", outcome: "ok" }),
        ]),
      );
      for (const phase of resources.phases) {
        expect(phase.wallMs).toBeGreaterThanOrEqual(0);
        expect(phase.before.rssBytes).toBeGreaterThan(0);
        expect(phase.after.processPeakRssBytes).toBeGreaterThan(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it("resumes a stopped run across a fresh native isolate without reseeding confirmed work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "m7-profile-resume-"));
  try {
    const paused = await runLocalInventoryProfile({
      directory,
      headCount: 1,
      maxRequests: 1,
    });
    expect(paused).toMatchObject({
      completed: false,
      phase: "start",
      requests: 1,
    });
    const resumed = await runLocalInventoryProfile({ directory, headCount: 1 });
    expect(resumed).toMatchObject({ completed: true, verifiedSummaries: 1 });
    const rows = readFileSync(join(directory, "trace.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(
      rows.filter(
        (line) =>
          line.includes('"kind":"reply"') && line.includes('"action":"seed"'),
      ),
    ).toHaveLength(1);
    await expect(
      runLocalInventoryProfile({ directory, headCount: 0 }),
    ).rejects.toThrow("another recipe");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
