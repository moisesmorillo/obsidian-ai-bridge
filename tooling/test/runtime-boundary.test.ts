import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("production tooling import boundary", () => {
	it.each([
		"@tooling/documentation",
		"@obsidian-ai-bridge/tooling/vite-aliases",
		"@ast-grep/napi",
		"@microsoft/tsdoc",
	])(
		"rejects production import %s while allowing the public protocol",
		async (specifier) => {
			const root = fileURLToPath(new URL("../../", import.meta.url));
			const directory = await mkdtemp(
				join(root, "apps/worker/src/.tooling-boundary-"),
			);
			try {
				const path = join(directory, "fixture.ts");
				/** Runs the real restriction rule against a file inside a production source root. */
				const lint = () =>
					spawnSync(
						join(root, "node_modules/.bin/biome"),
						["lint", "--only=style/noRestrictedImports", "--colors=off", path],
						{ cwd: root, encoding: "utf8" },
					);
				await writeFile(
					path,
					`import * as tooling from "${specifier}"; void tooling;`,
				);
				const forbidden = lint();
				expect(forbidden.status).not.toBe(0);
				expect(forbidden.stdout + forbidden.stderr).toContain(
					"noRestrictedImports",
				);
				await writeFile(
					path,
					'import { EpochSchema } from "@obsidian-ai-bridge/protocol"; void EpochSchema;',
				);
				const allowed = lint();
				expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
