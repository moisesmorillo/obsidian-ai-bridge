import { MirrorRequestGate } from "@obsidian-plugin/runtime/mirror-request-gate";
import { describe, expect, it, vi } from "vitest";

describe("MirrorRequestGate", () => {
  it("retains permits through disable until real settlement releases them", async () => {
    const gate = new MirrorRequestGate();
    gate.enable();
    const first = await gate.admit();
    const second = await gate.admit();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(await gate.admit()).toBeUndefined();
    expect(gate.activeCount()).toBe(2);

    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const unregister = gate.register(controller);
    gate.disable();
    expect(abort).toHaveBeenCalledOnce();
    expect(gate.activeCount()).toBe(2);
    expect(await gate.admit()).toBeUndefined();

    first?.release();
    expect(gate.activeCount()).toBe(1);
    gate.enable();
    const replacement = await gate.admit();
    expect(replacement).toBeDefined();
    unregister();
    second?.release();
    replacement?.release();
    expect(gate.activeCount()).toBe(0);
  });

  it("aborts a request registered after admission has already closed", () => {
    const gate = new MirrorRequestGate();
    const controller = new AbortController();
    gate.register(controller);
    expect(controller.signal.aborted).toBe(true);
  });
});
