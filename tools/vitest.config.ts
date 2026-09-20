import { defineProject } from "vitest/config";

const workspaceRoot = new URL("..", import.meta.url).pathname;

/** Tooling tests use disposable source trees, never mutation of repository production files. */
export default defineProject({
  resolve: {
    alias: {
      "@core": `${workspaceRoot}/packages/core/src`,
      "@worker": `${workspaceRoot}/apps/worker/src`,
    },
  },
  test: {
    name: "tools",
    include: ["tests/**/*.test.ts"],
  },
});
