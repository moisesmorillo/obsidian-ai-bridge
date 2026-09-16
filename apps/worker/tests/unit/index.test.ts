import { describe, expect, it } from "vitest";

describe("Worker entrypoint", () => {
  it("exports a fully assembled fetch application", async () => {
    const { default: worker } = await import("@worker/index");
    expect(worker).toHaveProperty("fetch");
    const response = await Reflect.apply(worker.fetch, worker, [
      new Request("https://example.test/api/v1/notes"),
      { OBSIDIAN_BRIDGE_TOKEN: "token" },
    ]);
    expect(response.status).toBe(401);
  });
});
