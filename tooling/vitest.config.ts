import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	resolve: {
		alias: { "@tooling": fileURLToPath(new URL(".", import.meta.url)) },
	},
	test: { include: ["tooling/test/**/*.test.ts"] },
});
