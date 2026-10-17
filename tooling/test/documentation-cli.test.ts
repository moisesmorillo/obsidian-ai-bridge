import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Executes the real gate against explicit paths without changing repository files. */
function runGate(paths: string[]) {
	return spawnSync(
		"bun",
		[
			fileURLToPath(new URL("../check-documentation.ts", import.meta.url)),
			...paths,
		],
		{ encoding: "utf8" },
	);
}

describe("documentation gate CLI", () => {
	it("returns failure for missing documentation and success for a documented control", async () => {
		const directory = await mkdtemp(join(tmpdir(), "documentation-gate-"));
		try {
			const path = join(directory, "fixture.ts");
			await writeFile(path, "function commit() {}");
			const missing = runGate([path]);
			expect(missing.status, missing.stderr).toBe(1);
			expect(missing.stdout).toContain("missing");
			expect(missing.stdout).toContain("commit");
			await writeFile(
				path,
				"/** Preserves the observed revision. */ function commit() {}",
			);
			const allowed = runGate([path]);
			expect(allowed.status, allowed.stderr).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("reports file access failures instead of accepting an empty inventory", () => {
		const result = runGate([
			join(tmpdir(), "absent-documentation-fixture", "source.ts"),
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unable to read");
	});
});
