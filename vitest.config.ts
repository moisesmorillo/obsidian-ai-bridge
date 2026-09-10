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
    projects: ["packages/*/vitest.config.ts", "apps/worker/vitest.config.ts"],
  },
});
