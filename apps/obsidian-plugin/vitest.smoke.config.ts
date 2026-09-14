import { defineConfig } from "vitest/config";

/** Artifact-only checks run after packaging, independently of source coverage tests. */
export default defineConfig({
  resolve: {
    alias: {
      "@obsidian-plugin-tests": new URL("tests", import.meta.url).pathname,
      "@obsidian-plugin-manifest": new URL("manifest.json", import.meta.url)
        .pathname,
    },
  },
  test: {
    name: "plugin-artifact",
    include: ["apps/obsidian-plugin/tests/artifact/*.test.ts"],
  },
});
