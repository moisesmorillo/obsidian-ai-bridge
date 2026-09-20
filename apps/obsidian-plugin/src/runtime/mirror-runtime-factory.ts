import {
  createDisabledMirrorState,
  createMirrorOperationId,
  createMirrorWriterId,
  type MirrorDeviceState,
  MirrorStateOwner,
  ReconciliationV3LocalEffectRecoveryService,
  staleOrphanedReconciliationReviews,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalReconciliationWriter } from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer";
import { createObsidianLocalReconciliationHost } from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer-host";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import { createObsidianVaultHost } from "@obsidian-plugin/infrastructure/obsidian-vault-host";
import {
  BrowserMirrorSynchronizerRuntime,
  hasMirrorRuntimeCryptography,
  probeMirrorRuntimeCryptography,
} from "@obsidian-plugin/runtime/mirror-runtime-cryptography";
import { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import { ObsidianMirrorStateStore } from "@obsidian-plugin/state/obsidian-mirror-state-store";
import type { App, Vault } from "obsidian";

/** Official host subset required to construct device-local runtime ownership. */
export type MirrorRuntimeAppHost = Pick<
  App,
  "loadLocalStorage" | "saveLocalStorage" | "secretStorage"
>;

/**
 * Loads or provisions device-local state before constructing the runtime owner.
 *
 * Missing state receives one new UUID-v4 and is saved before publication. Loading
 * may migrate valid v2/v3 state. Corrupt, future, unavailable or unsuccessfully saved
 * state prevents owner publication; host save failure does not prove no write occurred.
 *
 * @param app - Official App-local storage and SecretStorage capabilities.
 * @param vault - Official saved-file Vault capability.
 * @returns Initialized same-realm owner.
 * @throws A sanitized error when required local state cannot be loaded or persisted.
 */
export async function createMirrorRuntimeOwner(
  app: MirrorRuntimeAppHost,
  vault: Vault,
): Promise<MirrorRuntimeOwner> {
  if (!hasMirrorRuntimeCryptography(globalThis.crypto)) {
    throw new Error("Required runtime cryptography is unavailable.");
  }
  const store = new ObsidianMirrorStateStore(app);
  const loaded = await store.load();
  let state: MirrorDeviceState;
  if (loaded.kind === "valid") {
    state = loaded.state;
  } else if (loaded.kind === "missing") {
    const deviceId = createMirrorWriterId(globalThis.crypto.randomUUID());
    if (deviceId === undefined) {
      throw new Error("Required runtime identity is unavailable.");
    }
    state = createDisabledMirrorState(deviceId);
    const saved = await store.save(state);
    if (saved.kind !== "saved") {
      throw new Error("Device-local mirror state is unavailable.");
    }
  } else {
    throw new Error("Device-local mirror state is unavailable.");
  }
  const local = new ObsidianLocalVault(createObsidianVaultHost(vault));
  const runtime = new BrowserMirrorSynchronizerRuntime(globalThis.crypto);
  const stateOwner = new MirrorStateOwner(state, store);
  const migrationRecovery =
    await new ReconciliationV3LocalEffectRecoveryService({
      local,
      stateOwner,
      hashContent: (content) => runtime.hashContent(content),
      createEffectId: () => {
        const id = createMirrorOperationId(globalThis.crypto.randomUUID());
        if (id === undefined) {
          throw new Error("Required runtime identity is unavailable.");
        }
        return id;
      },
    }).recover();
  if (migrationRecovery.kind !== "completed") {
    throw new Error("Device-local mirror state is unavailable.");
  }
  const startupState = staleOrphanedReconciliationReviews(
    migrationRecovery.snapshot.state,
  );
  if (startupState !== migrationRecovery.snapshot.state) {
    const committed = await stateOwner.transition(() => startupState);
    if (committed.kind !== "committed") {
      throw new Error("Device-local mirror state is unavailable.");
    }
  }
  const localWriter = new ObsidianLocalReconciliationWriter(
    createObsidianLocalReconciliationHost(vault),
    runtime,
  );
  return new MirrorRuntimeOwner({
    stateOwner,
    local,
    localWriter,
    secretStorage: app.secretStorage,
    runtime,
    cryptography: globalThis.crypto,
    probeRuntime: () => probeMirrorRuntimeCryptography(globalThis.crypto),
  });
}
