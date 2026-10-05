import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostResourceRecorder,
  hostResourcesSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile-host-resources";
import { expect, it } from "vitest";

it("observes a phase without changing result identity or exception identity", () => {
  const recorder = new HostResourceRecorder();
  const result = { retained: true };
  expect(recorder.measure("verify_pair", () => result)).toBe(result);
  const failure = new RangeError("Original pair refusal.");
  let observedFailure: Error | null = null;
  try {
    recorder.measure("seal_pair", () => {
      throw failure;
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    observedFailure = error;
  }
  expect(observedFailure).toBe(failure);
  const directory = mkdtempSync(join(tmpdir(), "m7-host-measurement-"));
  try {
    const path = join(directory, "host-resources.json");
    recorder.save(path, "a".repeat(64), false, false);
    const report = hostResourcesSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(report).toMatchObject({
      sealed: false,
      traversalCompleted: false,
      peakRssScope: "node-process-lifetime",
      isolateCpu: "unavailable",
      isolateMemory: "unavailable",
    });
    expect(
      report.phases.map(({ phase, outcome }) => ({ phase, outcome })),
    ).toEqual([
      { phase: "verify_pair", outcome: "ok" },
      { phase: "seal_pair", outcome: "failed" },
    ]);
    expect(
      report.phases.every(
        ({ wallMs, before, after }) =>
          wallMs >= 0 && before.rssBytes > 0 && after.processPeakRssBytes > 0,
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
