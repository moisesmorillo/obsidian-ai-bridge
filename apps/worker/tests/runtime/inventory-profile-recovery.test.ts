import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalInventoryProfile } from "@worker-tests/runtime/fixtures/inventory-profile-driver";
import { readProfileTrace } from "@worker-tests/runtime/fixtures/inventory-profile-trace";
import { expect, it } from "vitest";

/** Counts only acknowledged LIST attempts; unresolved intents cannot be inferred as zero calls.
 * @param path Exact retained intent/reply journal belonging to this test runtime.
 * @returns Observed LIST attempts, used only to select the deterministic interruption boundary.
 */
function observedListAttempts(path: string): number {
  return readProfileTrace(path).replies.reduce(
    (total, reply) => total + reply.metrics.calls.list,
    0,
  );
}

it("recovers an acknowledged maximum-head LIST through a fresh isolate without relisting its durable chunk", async () => {
  const directory = mkdtempSync(join(tmpdir(), "m7-profile-chunk-recovery-"));
  const options = {
    directory,
    headCount: 1,
    fixtureKind: "maximum_encoded",
  } as const;
  try {
    await expect(
      runLocalInventoryProfile(options, (point) => {
        if (
          point === "after_trace" &&
          observedListAttempts(join(directory, "trace.jsonl")) > 0
        )
          throw new Error("Injected acknowledged LIST interruption.");
      }),
    ).rejects.toThrow("Injected acknowledged LIST interruption.");
    expect(observedListAttempts(join(directory, "trace.jsonl"))).toBe(1);
    const recovered = await runLocalInventoryProfile(options);
    expect(recovered).toMatchObject({
      completed: true,
      verifiedSummaries: 1,
      maxHeadBytes: 2048,
      accountingComplete: true,
      unresolvedRequests: 0,
    });
    expect(recovered.calls.list).toBe(1);
    expect(recovered.maxCallsPerRequest).toBeLessThanOrEqual(400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
