import { defineProject } from "vitest/config";

const protocolSource = new URL("src", import.meta.url).pathname;

export default defineProject({
  resolve: { alias: { "@protocol": protocolSource } },
  test: {
    name: "protocol",
    include: ["src/**/*.test.ts"],
  },
});
