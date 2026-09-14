import {
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  type MirrorStateSaveResult,
  type MirrorStateStore,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
  type MirrorDeviceStateDecodeResult,
} from "@obsidian-plugin/state/device-state-codec";
import {
  type HandoffIntegrity,
  verifyHandoffPayloadChecksum,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";

/** Narrow official App host-local storage capability used by the state adapter. */
export interface ObsidianLocalStorageHost {
  /** @param key - Package-specific host-local key. @returns Untrusted stored value. */
  loadLocalStorage?(key: string): unknown;
  /** @param key - Package-specific key. @param data - Serialized state or null. */
  saveLocalStorage?(key: string, data: string | null): void;
}

/**
 * Device-local state adapter backed only by App local storage.
 *
 * It never falls back to synced plugin data and never clears malformed/future data.
 */
export class ObsidianMirrorStateStore implements MirrorStateStore {
  /**
   * @param host - Official vault-local host storage capability.
   * @param integrity - Adapter-owned staged-handoff integrity capability.
   */
  constructor(
    private readonly host: ObsidianLocalStorageHost,
    private readonly integrity: HandoffIntegrity = new WebCryptoHandoffIntegrity(),
  ) {}

  /** @returns Strict load outcome, preserving unavailable separately from corrupt data. */
  async load(): Promise<
    MirrorDeviceStateDecodeResult | { readonly kind: "unavailable" }
  > {
    if (this.host.loadLocalStorage === undefined)
      return { kind: "unavailable" };
    try {
      return await decodeMirrorDeviceState(
        this.host.loadLocalStorage(MIRROR_DEVICE_STATE_STORAGE_KEY),
        this.integrity,
      );
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * @param state - Complete validated content-free state.
   * @returns Sanitized save result for the serialized core owner.
   */
  async save(state: MirrorDeviceState): Promise<MirrorStateSaveResult> {
    if (state.stagedHandoff !== null) {
      let checksumMatches: boolean;
      try {
        checksumMatches = await verifyHandoffPayloadChecksum(
          {
            associationId: state.stagedHandoff.associationId,
            origin: state.stagedHandoff.origin,
            entries: state.stagedHandoff.entries.map((entry) => ({
              path: entry.path,
              acknowledgement: entry.acknowledgement,
            })),
          },
          state.stagedHandoff.checksum,
          this.integrity,
        );
      } catch {
        return {
          kind: "failed",
          reason: MIRROR_STATE_STORE_FAILURE.unavailable,
        };
      }
      if (!checksumMatches) {
        return {
          kind: "failed",
          reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
        };
      }
    }
    let encoded: string;
    try {
      encoded = encodeMirrorDeviceState(state);
    } catch {
      return {
        kind: "failed",
        reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
      };
    }
    if (this.host.saveLocalStorage === undefined) {
      return { kind: "failed", reason: MIRROR_STATE_STORE_FAILURE.unavailable };
    }
    try {
      this.host.saveLocalStorage(MIRROR_DEVICE_STATE_STORAGE_KEY, encoded);
      return { kind: "saved" };
    } catch {
      return {
        kind: "failed",
        reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
      };
    }
  }
}
