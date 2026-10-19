import { defineConfig } from "vitest/config";
import { createWorkerTestConfig } from "./tooling/vitest-config";

export default defineConfig(
	createWorkerTestConfig(
		"test/fixtures/http-worker.ts",
		["test/http/**/*.test.ts"],
		[],
	),
);
