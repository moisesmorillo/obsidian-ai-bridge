import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readViteAliases, resolveViteAliases } from "@tooling/vite-aliases";
import { describe, expect, it } from "vitest";

describe("shared Vite alias conversion", () => {
	it("resolves selected wildcard and file mappings from the repository root", () => {
		expect(
			resolveViteAliases(
				"/repository",
				{
					"@protocol/*": ["./packages/protocol/src/*"],
					"@plugin-tools/build": ["./apps/plugin/build.ts"],
					"@worker/*": ["./apps/worker/src/*"],
				},
				["@protocol/*", "@plugin-tools/build"],
			),
		).toEqual([
			{
				find: "@protocol",
				replacement: resolve("/repository/packages/protocol/src"),
			},
			{
				find: "@plugin-tools/build",
				replacement: resolve("/repository/apps/plugin/build.ts"),
			},
		]);
	});
	const missingMappings: Record<string, string[]>[] = [
		{},
		{ "@missing/*": [] },
	];
	it.each(missingMappings)(
		"fails when a selected mapping has no target",
		(paths) => {
			expect(() =>
				resolveViteAliases("/repository", paths, ["@missing/*"]),
			).toThrow("Missing TypeScript alias mapping for @missing/*");
		},
	);
	it("loads the actual paths and rejects malformed repository JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "vite-aliases-"));
		try {
			await writeFile(
				join(root, "tsconfig.aliases.json"),
				JSON.stringify({
					compilerOptions: { paths: { "@sample/*": ["./sample/*"] } },
				}),
			);
			expect(readViteAliases(root, ["@sample/*"])).toEqual([
				{ find: "@sample", replacement: join(root, "sample") },
			]);
			await writeFile(join(root, "tsconfig.aliases.json"), "{");
			expect(() => readViteAliases(root, ["@sample/*"])).toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
