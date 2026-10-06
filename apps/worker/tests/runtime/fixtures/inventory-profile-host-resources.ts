import { renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** Host-only snapshots; RSS/heap are samples and OS peak RSS covers the entire Node process lifetime. */
const memorySchema = z
  .object({
    rssBytes: z.number().nonnegative(),
    heapUsedBytes: z.number().nonnegative(),
    heapTotalBytes: z.number().nonnegative(),
    externalBytes: z.number().nonnegative(),
    arrayBuffersBytes: z.number().nonnegative(),
    processPeakRssBytes: z.number().nonnegative(),
  })
  .strict();
/** Synchronous host phases measured without changing native request execution or persistence authority. */
const phaseSchema = z
  .object({
    phase: z.enum([
      "verify_pair",
      "recover_trace",
      "summarize_trace",
      "seal_pair",
    ]),
    outcome: z.enum(["ok", "failed"]),
    wallMs: z.number().nonnegative(),
    before: memorySchema,
    after: memorySchema,
  })
  .strict();
/** Auxiliary telemetry is never checkpoint/seal authority and explicitly excludes isolate qualification. */
export const hostResourcesSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("node-host-process-only"),
    recipeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    processId: z.number().int().positive(),
    measurementStartedAtEpochMs: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    peakRssScope: z.literal("node-process-lifetime"),
    sealed: z.boolean(),
    traversalCompleted: z.boolean(),
    isolateCpu: z.literal("unavailable"),
    isolateMemory: z.literal("unavailable"),
    phases: z.array(phaseSchema),
  })
  .strict();
/** Phase labels remain local to the host recorder, not Worker operation classifications. */
type HostPhase = z.infer<typeof phaseSchema>["phase"];
/** Validated host phase observation; snapshots are not phase allocation maxima. */
type HostPhaseObservation = z.infer<typeof phaseSchema>;

/** Samples Node memory and converts the documented resourceUsage KiB high-water mark to bytes.
 * @returns Host-process memory only; child workerd/Bun processes and isolates are excluded.
 */
function hostMemory() {
  const memory = process.memoryUsage();
  return memorySchema.parse({
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  });
}

/** Records host persistence/journal costs without becoming another restart or completion authority. */
export class HostResourceRecorder {
  /** Monotonic start includes emulator teardown/sealing but not the final telemetry file write. */
  readonly #started = performance.now();
  /** Epoch metadata correlates this invocation without pretending monotonic time is an epoch. */
  readonly #epoch = Date.now();
  /** Invocation-local observations; resumption overwrites telemetry, never sums sampled peaks. */
  readonly #phases: HostPhaseObservation[] = [];

  /** Measures one synchronous phase, preserving its return value or thrown failure exactly.
   * @param phase Host phase being observed; not a native binding operation.
   * @param operation Existing synchronous work whose authority and effects remain unchanged.
   * @returns The operation's original result; its original exception propagates after observation.
   */
  measure<T>(phase: HostPhase, operation: () => T): T {
    const before = hostMemory();
    const started = performance.now();
    let succeeded = false;
    try {
      const result = operation();
      succeeded = true;
      return result;
    } finally {
      this.#phases.push(
        phaseSchema.parse({
          phase,
          outcome: succeeded ? "ok" : "failed",
          wallMs: performance.now() - started,
          before,
          after: hostMemory(),
        }),
      );
    }
  }

  /** Atomically retains telemetry only for an admitted run; this file is excluded from pair authority.
   * @param path Auxiliary telemetry output for the currently locked directory.
   * @param recipe Exact recipe binding this host invocation to compiled fixture/driver inputs.
   * @param traversalCompleted Whether this invocation observed completed evidence traversal.
   * @param sealed Whether native disposal and pair sealing actually succeeded.
   */
  save(
    path: string,
    recipe: string,
    traversalCompleted: boolean,
    sealed: boolean,
  ): void {
    const report = hostResourcesSchema.parse({
      schemaVersion: 1,
      scope: "node-host-process-only",
      recipeSha256: recipe,
      processId: process.pid,
      measurementStartedAtEpochMs: this.#epoch,
      elapsedMs: performance.now() - this.#started,
      peakRssScope: "node-process-lifetime",
      sealed,
      traversalCompleted,
      isolateCpu: "unavailable",
      isolateMemory: "unavailable",
      phases: this.#phases,
    });
    writeFileSync(`${path}.tmp`, JSON.stringify(report, null, 2));
    renameSync(`${path}.tmp`, path);
  }
}
