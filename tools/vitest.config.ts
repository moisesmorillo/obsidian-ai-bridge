import { defineProject } from "vitest/config";

/** Tooling tests use disposable source trees, never mutation of repository production files. */
export default defineProject({
  test: {
    name: "tools",
    include: ["tests/**/*.test.ts"],
  },
});
