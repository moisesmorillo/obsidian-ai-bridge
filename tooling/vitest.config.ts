import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	root: fileURLToPath(new URL("../", import.meta.url)),
	resolve: {
		alias: [
			{
				find: "@tooling",
				replacement: fileURLToPath(new URL(".", import.meta.url)),
			},
			{
				find: "@protocol",
				replacement: fileURLToPath(
					new URL("../packages/protocol/src", import.meta.url),
				),
			},
		],
	},
	test: { include: ["tooling/test/**/*.test.ts"] },
});
