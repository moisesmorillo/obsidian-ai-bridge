import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

type AliasConfig = {
	compilerOptions: { paths: Record<string, string[]> };
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const aliasConfig = JSON.parse(
	readFileSync(new URL("../../tsconfig.aliases.json", import.meta.url), "utf8"),
) as AliasConfig;
const aliases = ["@worker/test-fixtures/*", "@worker/*", "@protocol/*"].map(
	(name) => {
		const target = aliasConfig.compilerOptions.paths[name]?.[0];
		if (!target)
			throw new Error(`Missing TypeScript alias mapping for ${name}`);
		return {
			find: name.replace(/\/\*$/, ""),
			replacement: resolve(repositoryRoot, target.replace(/\*$/, "")),
		};
	},
);

export default defineConfig({
	resolve: { alias: aliases },
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		// Workers cannot read Vitest's host-side persistent module cache files.
		fsModuleCache: false,
		include: ["test/**/*.test.ts"],
	},
});
