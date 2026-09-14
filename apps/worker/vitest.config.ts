import { defineProject } from "vitest/config";

const workspaceRoot = new URL("../..", import.meta.url).pathname;

export default defineProject({
  resolve: {
    alias: {
      "@core": `${workspaceRoot}/packages/core/src`,
      "@protocol": `${workspaceRoot}/packages/protocol/src`,
      "@worker": `${workspaceRoot}/apps/worker/src`,
      "@worker-tests": `${workspaceRoot}/apps/worker/tests`,
    },
  },
  test: {
    name: "worker",
    include: ["tests/{integration,unit}/**/*.test.ts"],
  },
});
