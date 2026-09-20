import {
  MIRROR_DEVICE_STATE_V2_VERSION,
  MIRROR_DEVICE_STATE_V3_VERSION,
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  type MirrorDeviceStateV2,
  type MirrorDeviceStateV3,
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
  migrateMirrorDeviceStateV2ToV3,
  migrateMirrorDeviceStateV3ToV4,
} from "@obsidian-plugin/state/device-state-migration";
import { decodeMirrorDeviceStateV2 } from "@obsidian-plugin/state/device-state-v2.codec";
import { decodeMirrorDeviceStateV3 } from "@obsidian-plugin/state/device-state-v3.codec";
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
  saveLocalStorage?(key: string, data: string | null): void | Promise<void>;
}

/** Migration mechanics injected only at the startup persistence boundary. */
export interface MirrorDeviceStateMigrationBoundary {
  /** @param state - Validated frozen version-2 input. @returns Frozen version-3 projection. */
  migrateV2(state: MirrorDeviceStateV2): MirrorDeviceStateV3;
  /** @param state - Validated frozen version-3 input. @returns Current version-4 projection. */
  migrateV3(state: MirrorDeviceStateV3): MirrorDeviceState;
  /** @param state - Validated migrated state. @returns Canonical version-4 JSON. */
  encode(state: MirrorDeviceState): string;
}

/** Production migration mechanics kept explicit for deterministic test substitution. */
const DEFAULT_MIGRATION_BOUNDARY: MirrorDeviceStateMigrationBoundary = {
  migrateV2: migrateMirrorDeviceStateV2ToV3,
  migrateV3: migrateMirrorDeviceStateV3ToV4,
  encode: encodeMirrorDeviceState,
};

/** Strict startup load outcome, including host/migration persistence unavailability. */
export type MirrorDeviceStateLoadResult =
  | MirrorDeviceStateDecodeResult
  | { readonly kind: "unavailable" };

/**
 * Device-local state adapter backed only by App local storage.
 *
 * Version-2/3 migration is completed and read-verified under the existing key before
 * version-4 state is returned. The adapter never publishes an in-memory migration,
 * falls back to synced plugin data, clears malformed data, or retries as an older
 * format after a version-4 write.
 */
export class ObsidianMirrorStateStore implements MirrorStateStore {
  /**
   * @param host - Official vault-local host storage capability.
   * @param integrity - Adapter-owned staged-handoff integrity capability.
   * @param migration - Deterministic migration/encoding boundary.
   */
  constructor(
    private readonly host: ObsidianLocalStorageHost,
    private readonly integrity: HandoffIntegrity = new WebCryptoHandoffIntegrity(),
    private readonly migration: MirrorDeviceStateMigrationBoundary = DEFAULT_MIGRATION_BOUNDARY,
  ) {}

  /**
   * Loads current state or crosses the version-2/3 migration fence through same-key save and exact read-back.
   * Host persistence is not a cross-process transaction or a rollback detector.
   *
   * @returns Strict version-4 load outcome; migration storage failures are unavailable.
   */
  async load(): Promise<MirrorDeviceStateLoadResult> {
    const stored = await this.loadRaw();
    if (stored.kind === "unavailable") return stored;

    let current: MirrorDeviceStateDecodeResult;
    try {
      current = await decodeMirrorDeviceState(stored.value, this.integrity);
    } catch {
      return { kind: "unavailable" };
    }
    if (current.kind !== "unsupported-version") return current;

    let historical: MirrorDeviceStateV3;
    try {
      if (current.version === MIRROR_DEVICE_STATE_V3_VERSION) {
        const decoded = await decodeMirrorDeviceStateV3(
          stored.value,
          this.integrity,
        );
        if (decoded.kind !== "valid") return decoded;
        historical = decoded.state;
      } else if (current.version === MIRROR_DEVICE_STATE_V2_VERSION) {
        const decoded = await decodeMirrorDeviceStateV2(
          stored.value,
          this.integrity,
        );
        if (decoded.kind !== "valid") return decoded;
        historical = this.migration.migrateV2(decoded.state);
      } else {
        return current;
      }
    } catch {
      return { kind: "unavailable" };
    }

    let migrated: MirrorDeviceState;
    let encoded: string;
    try {
      migrated = this.migration.migrateV3(historical);
      encoded = this.migration.encode(migrated);
    } catch {
      return { kind: "unavailable" };
    }

    const saved = await this.saveEncoded(encoded);
    if (saved.kind !== "saved") return { kind: "unavailable" };

    const readBack = await this.loadRaw();
    if (
      readBack.kind === "unavailable" ||
      typeof readBack.value !== "string" ||
      readBack.value !== encoded
    ) {
      return { kind: "unavailable" };
    }
    try {
      const verified = await decodeMirrorDeviceState(
        readBack.value,
        this.integrity,
      );
      return verified.kind === "valid" ? verified : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * @param state - Complete validated content-free version-4 state.
   * @returns Sanitized save result for the serialized core owner.
   */
  async save(state: MirrorDeviceState): Promise<MirrorStateSaveResult> {
    const integrityFailure = await this.handoffIntegrityFailure(state);
    if (integrityFailure !== undefined) return integrityFailure;
    let encoded: string;
    try {
      encoded = encodeMirrorDeviceState(state);
    } catch {
      return {
        kind: "failed",
        reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
      };
    }
    return this.saveEncoded(encoded);
  }

  /**
   * Refuses saving altered staged baselines; undefined means no integrity failure, not newly granted handoff authority.
   *
   * @returns A sanitized save failure, or undefined when integrity passes or is inapplicable.
   */
  private async handoffIntegrityFailure(
    state: MirrorDeviceState,
  ): Promise<MirrorStateSaveResult | undefined> {
    if (state.stagedHandoff === null) return undefined;
    try {
      const valid = await verifyHandoffPayloadChecksum(
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
      return valid
        ? undefined
        : {
            kind: "failed",
            reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
          };
    } catch {
      return { kind: "failed", reason: MIRROR_STATE_STORE_FAILURE.unavailable };
    }
  }

  /**
   * Reads the existing host-local key without defaults or reset; missing host capability and read failures stay unavailable.
   *
   * @returns The untouched raw host value or a sanitized read failure.
   */
  private async loadRaw(): Promise<
    | { readonly kind: "loaded"; readonly value: unknown }
    | { readonly kind: "unavailable" }
  > {
    if (this.host.loadLocalStorage === undefined) {
      return { kind: "unavailable" };
    }
    try {
      return {
        kind: "loaded",
        value: await this.host.loadLocalStorage(
          MIRROR_DEVICE_STATE_STORAGE_KEY,
        ),
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * Replaces the same local key once and sanitizes host failures; a failure cannot prove the write had no effect.
   *
   * @param encoded - Validated serialized snapshot to write to the device-local key.
   * @returns Save confirmation or a sanitized unavailable/storage failure.
   */
  private async saveEncoded(encoded: string): Promise<MirrorStateSaveResult> {
    if (this.host.saveLocalStorage === undefined) {
      return { kind: "failed", reason: MIRROR_STATE_STORE_FAILURE.unavailable };
    }
    try {
      await this.host.saveLocalStorage(
        MIRROR_DEVICE_STATE_STORAGE_KEY,
        encoded,
      );
      return { kind: "saved" };
    } catch {
      return {
        kind: "failed",
        reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
      };
    }
  }
}
