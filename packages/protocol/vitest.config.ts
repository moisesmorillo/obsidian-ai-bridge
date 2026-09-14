import { defineProject } from "vitest/config";

const protocolSource = new URL("src", import.meta.url).pathname;
const coreSource = new URL("../core/src", import.meta.url).pathname;

export default defineProject({
  resolve: { alias: { "@core": coreSource, "@protocol": protocolSource } },
  test: {
    name: "protocol",
    include: ["tests/**/*.test.ts"],
  },
});
