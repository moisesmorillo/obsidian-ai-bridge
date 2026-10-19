import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readViteAliases } from "@obsidian-ai-bridge/tooling/vite-aliases";
import type { ViteUserConfig as UserConfig } from "vitest/config";

/** Build an official Workers test configuration for one Worker entry and test subset. */
export function createWorkerTestConfig(
	main: string,
	include: string[],
	exclude: string[],
): UserConfig {
	const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const aliases = readViteAliases(repositoryRoot, [
		"@worker/test-fixtures/*",
		"@worker/*",
		"@protocol/*",
	]);
	return {
		resolve: { alias: aliases },
		plugins: [
			cloudflareTest({ main, wrangler: { configPath: "./wrangler.jsonc" } }),
		],
		test: { fsModuleCache: false, include, exclude },
	};
}
