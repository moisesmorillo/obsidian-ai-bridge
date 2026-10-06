import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION } from "@protocol/sync.constants";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import {
  PROFILE_FIXTURE_KINDS,
  type ProfileState,
  profileCountSchema,
  profileFixtureKindSchema,
  profileReplySchema,
  profileStateSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile.contract";
import { HostResourceRecorder } from "@worker-tests/runtime/fixtures/inventory-profile-host-resources";
import {
  sealProfilePair,
  verifyProfilePair,
} from "@worker-tests/runtime/fixtures/inventory-profile-persistence";
import { profileWait } from "@worker-tests/runtime/fixtures/inventory-profile-policy";
import {
  advanceProfileState,
  nextProfileRequest,
  observeProfileFailure,
} from "@worker-tests/runtime/fixtures/inventory-profile-state";
import {
  appendProfileTrace,
  readProfileTrace,
} from "@worker-tests/runtime/fixtures/inventory-profile-trace";
import { Miniflare } from "miniflare";
import { z } from "zod";

/** Hard local run deadline, never permission to extend the store's scan expiry. */
const PROFILE_DEADLINE_MS = 24 * 60 * 60 * 1000;
/** Finite progress dispatch cap; low-scale operator execution never launches maximal work implicitly. */
const PROFILE_MAX_REQUESTS = 200000;
/** Host pacing for progress without a response floor; no Worker sleep is introduced. */
const PROFILE_POLL_MS = 50;
/** Durable checkpoint binds local R2 state to the exact compiled fixture and driver recipe. */
const checkpointSchema = z
  .object({
    recipe: z.string().regex(/^[a-f0-9]{64}$/),
    state: profileStateSchema,
  })
  .strict();
/** Operator settings are validated before emulator setup or seeding. */
const optionsSchema = z
  .object({
    directory: z.string().min(1),
    headCount: profileCountSchema,
    fixtureKind: profileFixtureKindSchema.default(
      PROFILE_FIXTURE_KINDS.baseline,
    ),
    maxRequests: z.number().int().min(1).max(PROFILE_MAX_REQUESTS).optional(),
  })
  .strict();
/** Atomic rename prevents a partially written checkpoint from becoming restart authority.
 * @param path Private checkpoint path belonging to the locked output directory.
 * @param recipe Hash binding this state to fixture and driver sources.
 * @param state Validated successor whose reply was fully observed.
 */
function checkpoint(path: string, recipe: string, state: ProfileState): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ recipe, state }));
  renameSync(temporary, path);
}

/** Runs or resumes synthetic inventory using one method per request and persistent local-only R2.
 * The trace includes repeated dispatched requests after interrupted acknowledgements; checkpoints
 * advance only after validated replies. Missing isolate CPU/memory remains explicitly unavailable.
 * @param rawOptions Operator-supplied local directory, bounded count and optional pause cap.
 * @param interrupt Test-only interruption at acknowledgement boundaries; absent in operator execution.
 * @returns Retained completed/paused local report; refusal never becomes completion.
 */
export async function runLocalInventoryProfile(
  rawOptions: z.input<typeof optionsSchema>,
  interrupt?: (point: "after_dispatch" | "after_trace") => void,
) {
  const options = optionsSchema.parse(rawOptions);
  mkdirSync(options.directory, { recursive: true });
  const lockPath = join(options.directory, "run.lock");
  const lock = openSync(lockPath, "wx");
  let runtime: Miniflare | undefined;
  const resources = new HostResourceRecorder();
  let admittedRecipe: string | null = null;
  let traversalCompleted = false;
  let sealed = false;
  const staging = mkdtempSync(join(tmpdir(), "m7-profile-build-"));
  try {
    const resumed = resources.measure("verify_pair", () =>
      verifyProfilePair(options.directory),
    );
    const root = new URL("../../../../../", import.meta.url).pathname;
    const output = join(staging, "worker.mjs");
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
    const contents = readFileSync(output, "utf8");
    const manifest = z.object({ version: z.string().min(1) });
    const miniflareManifest = realpathSync(
      join(root, "apps/worker/node_modules/miniflare/package.json"),
    );
    const fromMiniflare = createRequire(miniflareManifest);
    const versions = {
      miniflare: manifest.parse(
        JSON.parse(readFileSync(miniflareManifest, "utf8")),
      ).version,
      workerd: manifest.parse(
        JSON.parse(
          readFileSync(fromMiniflare.resolve("workerd/package.json"), "utf8"),
        ),
      ).version,
      bun: execFileSync("bun", ["--version"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    };
    const recipe = createHash("sha256")
      .update(contents)
      .update(JSON.stringify({ versions, nodeVersion: process.version }));
    for (const name of [
      "inventory-profile-driver.ts",
      "inventory-profile-host-resources.ts",
      "inventory-profile-state.ts",
      "inventory-profile-policy.ts",
      "inventory-profile-persistence.ts",
      "inventory-profile-trace.ts",
      "inventory-profile.contract.ts",
    ])
      recipe.update(readFileSync(new URL(name, import.meta.url)));
    const recipeHash = recipe.digest("hex");
    const statePath = join(options.directory, "checkpoint.json");
    const tracePath = join(options.directory, "trace.jsonl");
    const loaded = existsSync(statePath)
      ? checkpointSchema.parse(JSON.parse(readFileSync(statePath, "utf8")))
      : null;
    if (
      loaded !== null &&
      (loaded.recipe !== recipeHash ||
        loaded.state.headCount !== options.headCount ||
        loaded.state.fixtureKind !== options.fixtureKind)
    )
      throw new RangeError(
        "Checkpoint belongs to another recipe; use a fresh output directory.",
      );
    let state =
      loaded?.state ??
      profileStateSchema.parse({
        headCount: options.headCount,
        fixtureKind: options.fixtureKind,
        phase: "seed",
        offset: 0,
        handle: null,
        cursor: "",
        seen: [],
        notBeforeMs: 0,
        startedAtMs: Date.now(),
        scanStartedAtMs: null,
        hasListed: false,
        maxHeadBytes: 0,
      });
    admittedRecipe = recipeHash;
    if (resumed) {
      if (
        resources.measure("recover_trace", () => readProfileTrace(tracePath))
          .unresolvedRequests > 0
      )
        state = profileStateSchema.parse({
          ...state,
          notBeforeMs: Math.max(
            state.notBeforeMs,
            Date.now() + SYNC_R2_WRITE_COOLDOWN_MS,
          ),
        });
      unlinkSync(join(options.directory, "pair.json"));
    } else {
      writeFileSync(join(options.directory, "worker.mjs"), contents);
      mkdirSync(join(options.directory, "r2-state"));
      writeFileSync(
        join(options.directory, "r2-state", "profile-identity"),
        randomUUID(),
      );
      writeFileSync(tracePath, "");
    }
    rmSync(join(options.directory, "report.json"), { force: true });
    rmSync(join(options.directory, "host-resources.json"), { force: true });
    checkpoint(statePath, recipeHash, state);
    runtime = new Miniflare({
      resourcePersistencePath: join(options.directory, "r2-state"),
      workers: [
        {
          config: {
            name: "inventory-profile",
            type: "worker",
            compatibilityDate: "2026-09-09",
            manifest: {
              mainModule: "worker.mjs",
              modulesRoot: options.directory,
              modules: { "worker.mjs": { type: "esm", contents } },
            },
            env: { BUCKET: { type: "r2", name: "inventory-profile" } },
          },
        },
      ],
    });
    await runtime.ready;
    let dispatched = 0;
    while (
      state.phase !== "done" &&
      dispatched < (options.maxRequests ?? PROFILE_MAX_REQUESTS)
    ) {
      const now = Date.now();
      const wait = profileWait(now, state.notBeforeMs);
      if (now + wait - state.startedAtMs >= PROFILE_DEADLINE_MS)
        throw new RangeError(
          "Local profile deadline reached; retain checkpoint, do not extend expiry.",
        );
      await setTimeout(wait);
      if (state.phase === "start" && state.scanStartedAtMs === null) {
        state = profileStateSchema.parse({
          ...state,
          scanStartedAtMs: Date.now(),
        });
        checkpoint(statePath, recipeHash, state);
      }
      const request = nextProfileRequest(state);
      const startedAtMs = Date.now();
      const id = randomUUID();
      appendProfileTrace(tracePath, {
        kind: "dispatch",
        id,
        request,
        startedAtMs,
      });
      const response = await runtime.dispatchFetch(
        "http://inventory-profile.test/profile",
        { method: "POST", body: JSON.stringify(request) },
      );
      interrupt?.("after_dispatch");
      const reply = profileReplySchema.parse(await response.json());
      dispatched += 1;
      appendProfileTrace(tracePath, {
        kind: "reply",
        id,
        action: request.action,
        startedAtMs,
        finishedAtMs: Date.now(),
        status: response.status,
        metrics: reply.metrics,
        result:
          reply.action === "inventory"
            ? reply.result.kind
            : reply.action === "page"
              ? reply.result.kind
              : reply.action,
        hostRssBytes: process.memoryUsage().rss,
      });
      interrupt?.("after_trace");
      if (reply.action === "failed") {
        state = observeProfileFailure(state, reply, Date.now());
        checkpoint(statePath, recipeHash, state);
        throw new Error(
          "Store outcome unresolved; retained same-phase checkpoint and safe floor.",
        );
      }
      if (response.status !== 200)
        throw new Error(
          "Local profile request failed; retained evidence is not completion.",
        );
      state = advanceProfileState(state, request, reply);
      state = profileStateSchema.parse({
        ...state,
        notBeforeMs: Math.max(state.notBeforeMs, Date.now() + PROFILE_POLL_MS),
      });
      checkpoint(statePath, recipeHash, state);
    }
    const trace = resources.measure("summarize_trace", () =>
      readProfileTrace(tracePath),
    );
    traversalCompleted = state.phase === "done";
    const rows = trace.replies;
    const report = {
      schemaVersion: 1,
      scope: "local-native-inventory-only",
      headCount: state.headCount,
      fixtureKind: state.fixtureKind,
      completed: state.phase === "done",
      phase: state.phase,
      elapsedMs: Date.now() - state.startedAtMs,
      scanElapsedMs:
        state.scanStartedAtMs === null
          ? null
          : Date.now() - state.scanStartedAtMs,
      requests: trace.requests,
      observedReplies: rows.length,
      accountingComplete: trace.accountingComplete,
      unresolvedRequests: trace.unresolvedRequests,
      callsScope: "observed-replies-only",
      unobservedCallsUpperBound:
        trace.unresolvedRequests * MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION,
      maxCallsPerRequest: rows.reduce(
        (maximum, { metrics }) =>
          Math.max(
            maximum,
            metrics.calls.get + metrics.calls.list + metrics.calls.put,
          ),
        0,
      ),
      calls: rows.reduce(
        (sum, { metrics }) => ({
          get: sum.get + metrics.calls.get,
          list: sum.list + metrics.calls.list,
          put: sum.put + metrics.calls.put,
        }),
        { get: 0, list: 0, put: 0 },
      ),
      maxHeadBytes: state.maxHeadBytes,
      verifiedSummaries: state.seen.length,
      handle: state.handle,
      cpu: "unavailable",
      isolateMemory: "unavailable",
      recipeSha256: recipeHash,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      sourceDirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).length > 0,
      nodeVersion: process.version,
      versions,
    };
    writeFileSync(
      join(options.directory, "report.json"),
      JSON.stringify(report, null, 2),
    );
    return report;
  } finally {
    try {
      if (runtime !== undefined) {
        await runtime.dispose();
        resources.measure("seal_pair", () =>
          sealProfilePair(options.directory),
        );
        sealed = true;
      }
    } finally {
      try {
        if (admittedRecipe !== null)
          resources.save(
            join(options.directory, "host-resources.json"),
            admittedRecipe,
            traversalCompleted,
            sealed,
          );
      } finally {
        rmSync(staging, { recursive: true, force: true });
        closeSync(lock);
        unlinkSync(lockPath);
      }
    }
  }
}
