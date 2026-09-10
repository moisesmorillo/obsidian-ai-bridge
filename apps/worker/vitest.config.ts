import { defineProject } from "vitest/config";

const workspaceRoot = new URL("../..", import.meta.url).pathname;

export default defineProject({
  resolve: {
    alias: {
      "@core": `${workspaceRoot}/packages/core/src`,
      "@protocol": `${workspaceRoot}/packages/protocol/src`,
      "@worker": `${workspaceRoot}/apps/worker/src`,
    },
  },
  test: {
    name: "worker",
    include: ["tests/**/*.test.ts"],
  },
});
