import { defineConfig } from "vitest/config";

const workerRoot = new URL(".", import.meta.url).pathname;

export default defineConfig({
  root: workerRoot,
  test: {
    include: ["tests/runtime/**/*.test.ts"],
    name: "worker-storage-runtime",
  },
});
