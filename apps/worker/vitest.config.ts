import { defineConfig } from "vitest/config";
import { createWorkerTestConfig } from "./tooling/vitest-config";

export default defineConfig(
	createWorkerTestConfig(
		"src/index.ts",
		["test/**/*.test.ts"],
		["test/http/**"],
	),
);
