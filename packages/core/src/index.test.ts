import { createIdentifier } from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

describe("createIdentifier", () => {
  it("normalizes a valid identifier", () => {
    expect(createIdentifier("  Remote-Agent ")).toBe("remote-agent");
  });

  it("rejects values outside the identifier format", () => {
    expect(createIdentifier("remote agent")).toBeUndefined();
  });
});
