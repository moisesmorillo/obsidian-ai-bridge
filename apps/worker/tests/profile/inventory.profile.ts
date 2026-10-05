import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLocalInventoryProfile } from "@worker-tests/runtime/fixtures/inventory-profile-driver";
import { profileHeadCount } from "@worker-tests/runtime/fixtures/inventory-profile-policy";
import { expect, it } from "vitest";

it("retains a native inventory profile, without claiming unavailable CPU/memory qualification", async () => {
  const headCount = profileHeadCount(process.env.M7_PROFILE_HEADS ?? "0");
  const root = new URL("../../../../", import.meta.url).pathname;
  const directory = resolve(
    process.env.M7_PROFILE_OUTPUT ??
      join(root, ".pi", "inventory-profiles", `${Date.now()}-${headCount}`),
  );
  mkdirSync(directory, { recursive: true });
  const report = await runLocalInventoryProfile({ directory, headCount });
  expect(report.completed).toBe(true);
  expect(report.accountingComplete).toBe(true);
  expect(report.verifiedSummaries).toBe(headCount);
  process.stdout.write(
    `Local-only profile report: ${join(directory, "report.json")}\n`,
  );
});
