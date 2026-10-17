import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readViteAliases } from "@obsidian-ai-bridge/tooling/vite-aliases";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const aliases = readViteAliases(repositoryRoot, ["@worker/*", "@protocol/*"]);

export default defineConfig({
	resolve: { alias: aliases },
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		// Workers cannot read Vitest's host-side persistent module cache files.
		fsModuleCache: false,
		include: ["test/**/*.test.ts"],
	},
});
