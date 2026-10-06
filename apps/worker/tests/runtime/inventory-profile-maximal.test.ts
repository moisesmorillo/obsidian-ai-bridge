import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalInventoryProfile } from "@worker-tests/runtime/fixtures/inventory-profile-driver";
import { expect, it } from "vitest";

it("completes maximum-encoded live and tombstone heads through native requests and refuses a different dataset on reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "m7-profile-maximal-"));
  try {
    const options = {
      directory,
      headCount: 2,
      fixtureKind: "maximum_encoded",
    } as const;
    const report = await runLocalInventoryProfile(options);
    expect(report).toMatchObject({
      completed: true,
      verifiedSummaries: 2,
      maxHeadBytes: 2048,
      accountingComplete: true,
    });
    expect(report.handle?.entryCount).toBe(2);
    expect(report.maxCallsPerRequest).toBeLessThanOrEqual(400);
    const trace = readFileSync(join(directory, "trace.jsonl"));
    const reopened = await runLocalInventoryProfile(options);
    expect(reopened.handle).toEqual(report.handle);
    expect(reopened.requests).toBe(report.requests);
    expect(readFileSync(join(directory, "trace.jsonl"))).toEqual(trace);
    await expect(
      runLocalInventoryProfile({ directory, headCount: 2 }),
    ).rejects.toThrow("another recipe");
    expect(readFileSync(join(directory, "trace.jsonl"))).toEqual(trace);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
