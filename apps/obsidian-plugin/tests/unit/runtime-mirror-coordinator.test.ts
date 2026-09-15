import {
  createDisabledMirrorState,
  createMirrorWriterId,
  MirrorStateOwner,
  type MirrorStateStore,
} from "@obsidian-ai-bridge/core";
import {
  acquireRuntimeMirrorCoordinator,
  MIRROR_RUNTIME_COORDINATOR_SYMBOL,
} from "@obsidian-plugin/state/runtime-mirror-coordinator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const store: MirrorStateStore = {
  save: async () => ({ kind: "saved" }),
};

function owner(): MirrorStateOwner {
  return new MirrorStateOwner(createDisabledMirrorState(DEVICE_ID), store);
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL);
});

describe("same-runtime mirror coordinator", () => {
  it("retains one state owner across Plugin instance replacement for the same App identity", () => {
    const app = {};
    const factory = vi.fn(owner);
    const first = acquireRuntimeMirrorCoordinator(app, factory);
    const replacement = acquireRuntimeMirrorCoordinator(app, factory);
    expect(first.kind).toBe("acquired");
    expect(replacement.kind).toBe("acquired");
    if (first.kind !== "acquired" || replacement.kind !== "acquired") {
      throw new Error("Expected coordinator.");
    }
    expect(replacement.coordinator).toBe(first.coordinator);
    expect(replacement.coordinator.stateOwner).toBe(
      first.coordinator.stateOwner,
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(Symbol.for("obsidian-ai-bridge.runtime-mirror-coordinator")).toBe(
      MIRROR_RUNTIME_COORDINATOR_SYMBOL,
    );
  });

  it("keeps separate App identities separate inside the same package registry", () => {
    const first = acquireRuntimeMirrorCoordinator({}, owner);
    const second = acquireRuntimeMirrorCoordinator({}, owner);
    expect(first.kind).toBe("acquired");
    expect(second.kind).toBe("acquired");
    if (first.kind !== "acquired" || second.kind !== "acquired") {
      throw new Error("Expected coordinators.");
    }
    expect(first.coordinator).not.toBe(second.coordinator);
  });

  it("fails closed for an incompatible coordinator inside a compatible registry", () => {
    const app = {};
    const coordinators = new WeakMap<object, object>();
    coordinators.set(app, { version: 1, stateOwner: {} });
    Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
      value: {
        format: "obsidian-ai-bridge-runtime-registry",
        version: 1,
        coordinators,
      },
      configurable: true,
    });
    expect(acquireRuntimeMirrorCoordinator(app, owner)).toEqual({
      kind: "incompatible-existing-owner",
    });
  });

  it("fails closed instead of replacing an incompatible existing global owner", () => {
    const incompatible = { version: 999, privateState: "PRIVATE" };
    Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
      value: incompatible,
      configurable: true,
    });
    expect(acquireRuntimeMirrorCoordinator({}, owner)).toEqual({
      kind: "incompatible-existing-owner",
    });
    expect(
      Object.getOwnPropertyDescriptor(
        globalThis,
        MIRROR_RUNTIME_COORDINATOR_SYMBOL,
      )?.value,
    ).toBe(incompatible);
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
