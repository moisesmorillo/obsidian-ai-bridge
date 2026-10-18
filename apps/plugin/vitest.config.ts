import { fileURLToPath } from "node:url";
import { readViteAliases } from "@obsidian-ai-bridge/tooling/vite-aliases";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const aliases = readViteAliases(repositoryRoot, [
	"@protocol/*",
	"@plugin/*",
	"@plugin-tools/build",
]);

export default defineConfig({
	resolve: {
		alias: [
			...aliases,
			{
				find: "obsidian",
				replacement: fileURLToPath(
					new URL("./test/obsidian.ts", import.meta.url),
				),
			},
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
