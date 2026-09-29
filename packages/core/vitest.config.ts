import { defineProject } from "vitest/config";

const coreSource = new URL("src", import.meta.url).pathname;
const protocolSource = new URL("../protocol/src", import.meta.url).pathname;

export default defineProject({
  resolve: { alias: { "@core": coreSource, "@protocol": protocolSource } },
  test: {
    name: "core",
    include: ["tests/**/*.test.ts"],
  },
});
