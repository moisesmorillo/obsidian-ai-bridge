import type { MirrorStateOwner } from "@obsidian-ai-bridge/core";

/** Package-specific same-JS-host registry key; it is not a distributed lock. */
export const MIRROR_RUNTIME_COORDINATOR_SYMBOL = Symbol.for(
  "obsidian-ai-bridge.runtime-mirror-coordinator",
);

/** Current structural registry contract shared across same-realm bundle replacement. */
export const MIRROR_RUNTIME_COORDINATOR_VERSION = 1;

/** One runtime owner retained for the identity of an official Obsidian App object. */
export interface RuntimeMirrorCoordinator {
  readonly version: typeof MIRROR_RUNTIME_COORDINATOR_VERSION;
  readonly stateOwner: MirrorStateOwner;
}

/** Result of acquiring same-runtime ownership without replacing incompatible state. */
export type RuntimeMirrorCoordinatorResult =
  | {
      readonly kind: "acquired";
      readonly coordinator: RuntimeMirrorCoordinator;
    }
  | { readonly kind: "incompatible-existing-owner" };

interface RuntimeCoordinatorRegistry {
  readonly format: "obsidian-ai-bridge-runtime-registry";
  readonly version: typeof MIRROR_RUNTIME_COORDINATOR_VERSION;
  readonly coordinators: WeakMap<object, RuntimeMirrorCoordinator>;
}

/**
 * Acquires the one state-transition owner for an App identity in this JavaScript host.
 *
 * A registry and coordinator survive Plugin instance replacement and compatible
 * bundle reload in the same realm. Incompatible global state fails closed instead
 * of being overwritten. This is not cross-process, cross-device, or OS locking.
 *
 * @param appIdentity - Actual official App object identity.
 * @param createStateOwner - Lazy construction used only for the first owner.
 * @returns Existing/new compatible owner, or a closed incompatibility refusal.
 */
export function acquireRuntimeMirrorCoordinator(
  appIdentity: object,
  createStateOwner: () => MirrorStateOwner,
): RuntimeMirrorCoordinatorResult {
  const registryResult = acquireRegistry();
  if (registryResult.kind === "incompatible-existing-owner")
    return registryResult;
  const existing: unknown =
    registryResult.registry.coordinators.get(appIdentity);
  if (existing !== undefined) {
    return isRuntimeMirrorCoordinator(existing)
      ? { kind: "acquired", coordinator: existing }
      : { kind: "incompatible-existing-owner" };
  }
  const coordinator: RuntimeMirrorCoordinator = {
    version: MIRROR_RUNTIME_COORDINATOR_VERSION,
    stateOwner: createStateOwner(),
  };
  registryResult.registry.coordinators.set(appIdentity, coordinator);
  return { kind: "acquired", coordinator };
}

function acquireRegistry():
  | { readonly kind: "ready"; readonly registry: RuntimeCoordinatorRegistry }
  | { readonly kind: "incompatible-existing-owner" } {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    MIRROR_RUNTIME_COORDINATOR_SYMBOL,
  );
  if (descriptor !== undefined) {
    const existing: unknown = descriptor.value;
    return isRuntimeCoordinatorRegistry(existing)
      ? { kind: "ready", registry: existing }
      : { kind: "incompatible-existing-owner" };
  }
  const registry: RuntimeCoordinatorRegistry = {
    format: "obsidian-ai-bridge-runtime-registry",
    version: MIRROR_RUNTIME_COORDINATOR_VERSION,
    coordinators: new WeakMap(),
  };
  Object.defineProperty(globalThis, MIRROR_RUNTIME_COORDINATOR_SYMBOL, {
    value: registry,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return { kind: "ready", registry };
}

function isRuntimeMirrorCoordinator(
  value: unknown,
): value is RuntimeMirrorCoordinator {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== MIRROR_RUNTIME_COORDINATOR_VERSION ||
    !("stateOwner" in value)
  ) {
    return false;
  }
  const owner = value.stateOwner;
  return (
    typeof owner === "object" &&
    owner !== null &&
    "snapshot" in owner &&
    typeof owner.snapshot === "function" &&
    "commit" in owner &&
    typeof owner.commit === "function" &&
    "transition" in owner &&
    typeof owner.transition === "function" &&
    "verifyPersistence" in owner &&
    typeof owner.verifyPersistence === "function"
  );
}

function isRuntimeCoordinatorRegistry(
  value: unknown,
): value is RuntimeCoordinatorRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === "obsidian-ai-bridge-runtime-registry" &&
    "version" in value &&
    value.version === MIRROR_RUNTIME_COORDINATOR_VERSION &&
    "coordinators" in value &&
    value.coordinators instanceof WeakMap
  );
}
