import { defineConfig } from "vitest/config";

const workspaceRoot = new URL(".", import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@core": `${workspaceRoot}packages/core/src`,
      "@protocol": `${workspaceRoot}packages/protocol/src`,
      "@worker": `${workspaceRoot}apps/worker/src`,
      "@obsidian-plugin": `${workspaceRoot}apps/obsidian-plugin/src`,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.types.ts",
        "**/dist/**",
        "**/build/**",
        "**/out/**",
        "**/.wrangler/**",
      ],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 94,
        branches: 90,
      },
    },
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
  },
});
