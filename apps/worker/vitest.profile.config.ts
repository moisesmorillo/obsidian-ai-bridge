import { defineConfig } from "vitest/config";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: { tsconfigPaths: true },
  test: {
    name: "local-inventory-profile",
    include: ["tests/profile/**/*.profile.ts"],
    testTimeout: 24 * 60 * 60 * 1000,
  },
});
