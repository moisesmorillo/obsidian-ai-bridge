import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Trusted alias configuration read from the repository, not external input validation. */
type AliasConfig = {
	compilerOptions: { paths: Record<string, string[]> };
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const aliasConfig = JSON.parse(
	readFileSync(new URL("../../tsconfig.aliases.json", import.meta.url), "utf8"),
) as AliasConfig;
const aliases = ["@protocol/*"].map((name) => {
	const target = aliasConfig.compilerOptions.paths[name]?.[0];
	if (!target) throw new Error(`Missing TypeScript alias mapping for ${name}`);
	return {
		find: name.replace(/\/\*$/, ""),
		replacement: resolve(repositoryRoot, target.replace(/\*$/, "")),
	};
});

export default defineConfig({
	resolve: { alias: aliases },
	test: {
		include: ["test/**/*.test.ts"],
		passWithNoTests: false,
	},
});
