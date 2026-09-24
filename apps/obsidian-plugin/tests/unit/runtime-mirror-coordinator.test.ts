import {
  createContentSha256,
  createDisabledMirrorState,
  createMirrorOperationId,
  createMirrorWriterId,
  MirrorStateOwner,
  type MirrorStateStore,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import {
  MIRROR_RUNTIME_OWNER_VERSION,
  MirrorRuntimeOwner,
} from "@obsidian-plugin/runtime/mirror-runtime-owner";
import {
  acquireRuntimeMirrorCoordinator,
  MIRROR_RUNTIME_COORDINATOR_SYMBOL,
  MIRROR_RUNTIME_COORDINATOR_VERSION,
} from "@obsidian-plugin/state/runtime-mirror-coordinator";
import { FakeVaultHost } from "@obsidian-plugin-tests/support/fake-vault-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const OPERATION_ID = required(
  createMirrorOperationId("22222222-2222-4222-8222-222222222222"),
);
const EMPTY_HASH = required(createContentSha256("0".repeat(64)));
const store: MirrorStateStore = {
  save: async () => ({ kind: "saved" }),
};

function owner(): MirrorRuntimeOwner {
  return new MirrorRuntimeOwner({
    stateOwner: new MirrorStateOwner(
      createDisabledMirrorState(DEVICE_ID),
      store,
    ),
    local: new ObsidianLocalVault(new FakeVaultHost()),
    secretStorage: { getSecret: () => null },
    runtime: {
      nowMilliseconds: () => 0,
      hashContent: async () => EMPTY_HASH,
      createOperationId: () => OPERATION_ID,
    },
  });
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL);
});

describe("same-runtime mirror coordinator", () => {
  it("retains one owner across Plugin replacement and concurrent async acquisition", async () => {
    const app = {};
    const pending = Promise.withResolvers<MirrorRuntimeOwner>();
    const factory = vi.fn(() => pending.promise);
    const firstPending = acquireRuntimeMirrorCoordinator(app, factory);
    const replacementPending = acquireRuntimeMirrorCoordinator(app, factory);
    const created = owner();
    pending.resolve(created);
    const [first, replacement] = await Promise.all([
      firstPending,
      replacementPending,
    ]);
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

  it("allows a later enable to retry after owner initialization rejects", async () => {
    const app = {};
    const created = owner();
    const factory = vi
      .fn<() => Promise<MirrorRuntimeOwner>>()
      .mockRejectedValueOnce(new Error("PRIVATE initialization detail"))
      .mockResolvedValueOnce(created);
    await expect(
      acquireRuntimeMirrorCoordinator(app, factory),
    ).resolves.toEqual({ kind: "initialization-failed" });
    await expect(
      acquireRuntimeMirrorCoordinator(app, factory),
    ).resolves.toEqual({ kind: "acquired", coordinator: created });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("keeps separate App identities separate inside the same package registry", async () => {
    const first = await acquireRuntimeMirrorCoordinator({}, async () =>
      owner(),
    );
    const second = await acquireRuntimeMirrorCoordinator({}, async () =>
      owner(),
    );
    expect(first.kind).toBe("acquired");
    expect(second.kind).toBe("acquired");
    if (first.kind !== "acquired" || second.kind !== "acquired") {
      throw new Error("Expected coordinators.");
    }
    expect(first.coordinator).not.toBe(second.coordinator);
  });

  it("fails closed for an incompatible coordinator inside a compatible registry", async () => {
    const app = {};
    const coordinators = new WeakMap<object, Promise<object>>();
    coordinators.set(app, Promise.resolve({ version: 1, stateOwner: {} }));
    Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
      value: {
        format: "obsidian-ai-bridge-runtime-registry",
        version: MIRROR_RUNTIME_COORDINATOR_VERSION,
        coordinators,
      },
      configurable: true,
    });
    await expect(
      acquireRuntimeMirrorCoordinator(app, async () => owner()),
    ).resolves.toEqual({ kind: "incompatible-existing-owner" });
    expect(MIRROR_RUNTIME_OWNER_VERSION).toBe(5);
  });

  it("rejects a v5 owner missing any new gap-authority member", async () => {
    const app = {};
    const gapMembers = [
      "failObservationDelivery",
      "listObservationGaps",
      "createObservationGapReview",
      "closeObservationGapReview",
      "submitObservationGapReview",
    ] as const;

    for (const missingMember of gapMembers) {
      Reflect.deleteProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL);
      const compatible = owner();
      const incomplete = new Proxy(compatible, {
        get(target, property, receiver) {
          return property === missingMember
            ? undefined
            : Reflect.get(target, property, receiver);
        },
      });
      const coordinators = new WeakMap<object, Promise<MirrorRuntimeOwner>>();
      coordinators.set(app, Promise.resolve(incomplete));
      Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
        value: {
          format: "obsidian-ai-bridge-runtime-registry",
          version: MIRROR_RUNTIME_COORDINATOR_VERSION,
          coordinators,
        },
        configurable: true,
      });

      await expect(
        acquireRuntimeMirrorCoordinator(app, async () => owner()),
      ).resolves.toEqual({ kind: "incompatible-existing-owner" });
    }
  });

  it("refuses and preserves a v4 registry when v5 code enters the same realm", async () => {
    const oldRegistry = {
      format: "obsidian-ai-bridge-runtime-registry",
      version: 4,
      coordinators: new WeakMap(),
    };
    Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
      value: oldRegistry,
      configurable: true,
    });
    const factory = vi.fn(async () => owner());
    await expect(acquireRuntimeMirrorCoordinator({}, factory)).resolves.toEqual(
      { kind: "incompatible-existing-owner" },
    );
    expect(factory).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(
        globalThis,
        MIRROR_RUNTIME_COORDINATOR_SYMBOL,
      )?.value,
    ).toBe(oldRegistry);
    expect(MIRROR_RUNTIME_COORDINATOR_VERSION).toBe(5);
  });

  it("fails closed instead of replacing an incompatible existing global owner", async () => {
    const incompatible = { version: 999, privateState: "PRIVATE" };
    Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
      value: incompatible,
      configurable: true,
    });
    await expect(
      acquireRuntimeMirrorCoordinator({}, async () => owner()),
    ).resolves.toEqual({ kind: "incompatible-existing-owner" });
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
