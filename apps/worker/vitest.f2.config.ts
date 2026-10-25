import { defineConfig } from "vitest/config";
import { createWorkerTestConfig } from "./tooling/vitest-config";

export default defineConfig(
	createWorkerTestConfig(
		"src/index.ts",
		["test/f2/**/*.test.ts"],
		[],
		"./wrangler.f2.jsonc",
	),
);
