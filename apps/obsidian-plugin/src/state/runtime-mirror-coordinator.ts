import {
  MIRROR_RUNTIME_OWNER_VERSION,
  type MirrorRuntimeOwner,
} from "@obsidian-plugin/runtime/mirror-runtime-owner";

/** Package-specific same-JS-host registry key; it is not a distributed lock. */
export const MIRROR_RUNTIME_COORDINATOR_SYMBOL = Symbol.for(
  "obsidian-ai-bridge.runtime-mirror-coordinator",
);

/** Current structural registry contract shared across same-realm bundle replacement. */
export const MIRROR_RUNTIME_COORDINATOR_VERSION = 3;

/** Result of acquiring same-runtime ownership without replacing incompatible state. */
export type RuntimeMirrorCoordinatorResult =
  | { readonly kind: "acquired"; readonly coordinator: MirrorRuntimeOwner }
  | { readonly kind: "incompatible-existing-owner" }
  | { readonly kind: "initialization-failed" };

interface RuntimeCoordinatorRegistry {
  readonly format: "obsidian-ai-bridge-runtime-registry";
  readonly version: typeof MIRROR_RUNTIME_COORDINATOR_VERSION;
  readonly coordinators: WeakMap<object, Promise<MirrorRuntimeOwner>>;
}

/**
 * Acquires the one runtime owner for an App identity in this JavaScript host.
 *
 * The lazy promise closes concurrent first-enable races before asynchronous local
 * state loading starts. Compatible plugin/bundle replacements await the same owner;
 * incompatible global state is never overwritten. The registry value itself contains
 * no bearer, note body, file object, plugin instance, or serializable diagnostics.
 *
 * @param appIdentity - Actual official App identity used only as the WeakMap key.
 * @param createCoordinator - Lazy asynchronous owner construction for first use.
 * @returns Existing/new compatible owner or one fail-closed refusal.
 */
export async function acquireRuntimeMirrorCoordinator(
  appIdentity: object,
  createCoordinator: () => Promise<MirrorRuntimeOwner>,
): Promise<RuntimeMirrorCoordinatorResult> {
  const registryResult = acquireRegistry();
  if (registryResult.kind === "incompatible-existing-owner") {
    return registryResult;
  }
  let pending = registryResult.registry.coordinators.get(appIdentity);
  if (pending === undefined) {
    try {
      pending = Promise.resolve(createCoordinator());
    } catch {
      return { kind: "initialization-failed" };
    }
    registryResult.registry.coordinators.set(appIdentity, pending);
  }
  let coordinator: MirrorRuntimeOwner;
  try {
    coordinator = await pending;
  } catch {
    if (registryResult.registry.coordinators.get(appIdentity) === pending) {
      registryResult.registry.coordinators.delete(appIdentity);
    }
    return { kind: "initialization-failed" };
  }
  return isRuntimeMirrorCoordinator(coordinator)
    ? { kind: "acquired", coordinator }
    : { kind: "incompatible-existing-owner" };
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
): value is MirrorRuntimeOwner {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== MIRROR_RUNTIME_OWNER_VERSION ||
    !("stateOwner" in value)
  ) {
    return false;
  }
  const stateOwner = value.stateOwner;
  if (typeof stateOwner !== "object" || stateOwner === null) return false;
  return (
    hasFunction(stateOwner, "snapshot") &&
    hasFunction(value, "attach") &&
    hasFunction(value, "detach") &&
    hasFunction(value, "isAttached") &&
    hasFunction(value, "applyConfiguration") &&
    hasFunction(value, "onLayoutReady") &&
    hasFunction(value, "observePresent") &&
    hasFunction(value, "observeDelete") &&
    hasFunction(value, "observeRename") &&
    hasFunction(value, "observeFolderRename") &&
    hasFunction(value, "nextWakeAtMilliseconds") &&
    hasFunction(value, "synchronizeReady") &&
    hasFunction(value, "checkNow") &&
    hasFunction(value, "retryFailures") &&
    hasFunction(value, "pause") &&
    hasFunction(value, "activate") &&
    hasFunction(value, "resume") &&
    hasFunction(value, "prepareHandoff") &&
    hasFunction(value, "importHandoff") &&
    hasFunction(value, "status")
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

/**
 * @param value - Candidate structural owner.
 * @param key - Required callable member name.
 * @returns Whether the compatibility member is callable.
 */
function hasFunction(value: object, key: string): boolean {
  return key in value && typeof value[key as keyof typeof value] === "function";
}
