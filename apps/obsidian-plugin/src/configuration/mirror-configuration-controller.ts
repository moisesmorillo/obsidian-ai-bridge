import type {
  MirrorPreferences,
  MirrorPreferencesDecodeResult,
  ObsidianPluginDataStore,
} from "@obsidian-plugin/configuration/mirror-preferences";
import type { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";

/** Empty non-authoritative preferences used only for explicit first-time editing. */
export const EMPTY_MIRROR_PREFERENCES: MirrorPreferences = {
  origin: null,
  loopbackHttpOrigin: null,
  secretReference: null,
};

/**
 * Serializes explicit data.json preference edits and external reloads.
 *
 * Device activation and the mirror ledger never enter this controller. Every
 * successfully loaded/saved snapshot is immediately revalidated by the runtime
 * owner, which closes admission before any incompatible connection can be reused.
 */
export class MirrorConfigurationController {
  private decoded:
    | MirrorPreferencesDecodeResult
    | { readonly kind: "unavailable" } = { kind: "missing" };
  private queue: Promise<void> = Promise.resolve();
  private attached = true;

  /**
   * @param store - Strict plugin data boundary.
   * @param owner - Same-realm runtime owner receiving validated snapshots.
   */
  constructor(
    private readonly store: ObsidianPluginDataStore,
    private readonly owner: MirrorRuntimeOwner,
  ) {}

  /**
   * Loads and applies the initial strict configuration snapshot.
   *
   * @param decoded - Optional snapshot already loaded before runtime acquisition.
   */
  async initialize(
    decoded?: MirrorPreferencesDecodeResult | { readonly kind: "unavailable" },
  ): Promise<void> {
    const loaded = decoded ?? (await this.store.load());
    if (!this.attached) return;
    this.decoded = loaded;
    await this.owner.applyConfiguration(this.decoded);
  }

  /**
   * Reloads externally modified data.json and fails closed on any mismatch.
   * @returns After strict reload and runtime admission reconciliation settle.
   */
  async reloadExternal(): Promise<void> {
    return this.enqueue(async () => {
      const loaded = await this.store.load();
      if (!this.attached) return;
      this.decoded = loaded;
      await this.owner.applyConfiguration(this.decoded);
    });
  }

  /** @returns Current valid preferences or an empty editing view without repairing data. */
  current(): MirrorPreferences {
    return this.decoded.kind === "valid"
      ? this.decoded.preferences
      : EMPTY_MIRROR_PREFERENCES;
  }

  /** @returns Whether current data.json is malformed, future, or unavailable. */
  isInvalid(): boolean {
    return !["missing", "valid"].includes(this.decoded.kind);
  }

  /**
   * Explicitly saves one complete validated preference snapshot.
   *
   * @param preferences - Complete endpoint/consent/secret-reference values.
   * @returns Whether persistence and runtime application both completed.
   */
  async save(preferences: MirrorPreferences): Promise<boolean> {
    let saved = false;
    await this.enqueue(async () => {
      const result = await this.store.save(preferences);
      if (result.kind !== "saved" || !this.attached) return;
      this.decoded = { kind: "valid", preferences };
      await this.owner.applyConfiguration(this.decoded);
      saved = true;
    });
    return saved;
  }

  /** Prevents late external-load or save callbacks from mutating runtime configuration. */
  detach(): void {
    this.attached = false;
  }

  /**
   * Serializes preference operations while keeping later operations runnable after a predecessor rejects.
   *
   * @param operation - Deferred preference work to run after prior operations settle.
   * @returns The queued operation's result or rejection.
   */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
