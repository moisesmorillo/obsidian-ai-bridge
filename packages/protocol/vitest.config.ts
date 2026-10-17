import { fileURLToPath } from "node:url";
import { readViteAliases } from "@obsidian-ai-bridge/tooling/vite-aliases";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const aliases = readViteAliases(repositoryRoot, ["@protocol/*"]);

export default defineConfig({
	resolve: { alias: aliases },
	test: {
		include: ["test/**/*.test.ts"],
		passWithNoTests: false,
	},
});
