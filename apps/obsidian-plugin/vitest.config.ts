import { defineProject } from "vitest/config";

const pluginRoot = new URL(".", import.meta.url).pathname;

export default defineProject({
  resolve: {
    alias: {
      "@core": new URL("../../packages/core/src", import.meta.url).pathname,
      "@obsidian-plugin-tests": `${pluginRoot}tests`,
      "@obsidian-plugin": `${pluginRoot}src`,
    },
  },
  test: {
    name: "obsidian-plugin",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
