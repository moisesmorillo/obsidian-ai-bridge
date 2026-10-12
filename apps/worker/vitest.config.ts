import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		// Workers cannot read Vitest's host-side persistent module cache files.
		fsModuleCache: false,
		include: ["test/**/*.test.ts"],
	},
});
