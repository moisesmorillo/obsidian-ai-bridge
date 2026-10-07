import type {
  SyncDemoClientBinding,
  SyncDemoLedger,
  SyncDemoLedgerStore,
  SyncDemoStringStorage,
} from "@obsidian-ai-bridge/core";
import {
  encodeSyncCursor,
  SYNC_FEED_LANE_COUNT,
  SYNC_SEQUENCE_WIDTH,
  syncDemoClientPathSchema,
  syncDemoLedgerSchema,
  syncDeviceIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";

/** Encoded content-free state ceiling in UTF-8 bytes; three bounded entries and one checkpoint fit without storing bodies. */
const MAX_LEDGER_BYTES = 16 * 1024;

/** Read-back verified, fail-closed adapter for the separate experimental host-local ledger; requires one serialized owner. */
export class SyncDemoLedgerRepository implements SyncDemoLedgerStore {
  /** Decode/write/read-back uncertainty permanently closes this instance; only a new verified owner may rehydrate storage. */
  private fenced = false;
  /** Captures one non-secret binding and a host-local string capability; never touches release state. */
  constructor(
    private readonly storage: SyncDemoStringStorage,
    private readonly binding: SyncDemoClientBinding,
  ) {}
  /** Initializes only positively absent storage; corrupt, unavailable, foreign or unsupported state stays blocked and unchanged.
   * @returns Strict bound read-back-verified state or a closed persistence barrier.
   */
  async load(): ReturnType<SyncDemoLedgerStore["load"]> {
    if (this.fenced) return { kind: "blocked" };
    try {
      const serialized = await this.storage.read();
      if (serialized !== null) {
        const ledger = this.decode(serialized);
        if (ledger !== null) return { kind: "ready", ledger };
        this.fenced = true;
        return { kind: "blocked" };
      }
      const vaultId = syncVaultIdSchema.parse(this.binding.vaultId);
      const deviceId = syncDeviceIdSchema.parse(this.binding.deviceId);
      const ledger: SyncDemoLedger = {
        schemaVersion: 1,
        vaultId,
        deviceId,
        cursor: encodeSyncCursor({
          protocolMajor: 1,
          vaultId,
          laneSequences: Array.from({ length: SYNC_FEED_LANE_COUNT }, () =>
            syncSequenceSchema.parse("0".repeat(SYNC_SEQUENCE_WIDTH)),
          ),
          nextLane: 0,
        }),
        entries: this.binding.paths.map((path) => ({
          path: syncDemoClientPathSchema.parse(path),
          base: null,
          work: null,
        })),
      };
      return (await this.save(ledger))
        ? { kind: "ready", ledger }
        : { kind: "blocked" };
    } catch {
      this.fenced = true;
      return { kind: "blocked" };
    }
  }
  /** Publishes no state unless strict serialization and exact persisted read-back both prove the whole transition.
   * @param ledger Complete content-free successor for the exact configured identity/path order.
   * @returns Whether durable proof permits publication; false permanently fences this owner.
   */
  async save(ledger: SyncDemoLedger): Promise<boolean> {
    if (this.fenced) return false;
    try {
      const serialized = JSON.stringify(ledger);
      if (this.decode(serialized) === null) {
        this.fenced = true;
        return false;
      }
      await this.storage.write(serialized);
      if ((await this.storage.read()) === serialized) return true;
    } catch {
      /* Uncertainty closes admission; no raw host failure escapes. */
    }
    this.fenced = true;
    return false;
  }
  /** Converts validated boundary input to bound domain state without resetting or repairing fields.
   * @param serialized Untrusted host-local state, never an authority until strict decoding succeeds.
   * @returns Exact typed rehydration or null for unsupported/corrupt/foreign state.
   */
  private decode(serialized: string): SyncDemoLedger | null {
    if (
      serialized.length > MAX_LEDGER_BYTES ||
      new TextEncoder().encode(serialized).byteLength > MAX_LEDGER_BYTES
    )
      return null;
    const parsed = syncDemoLedgerSchema.safeParse(JSON.parse(serialized));
    if (!parsed.success) return null;
    const ledger = parsed.data;
    if (
      ledger.vaultId !== this.binding.vaultId ||
      ledger.deviceId !== this.binding.deviceId ||
      ledger.entries.length !== this.binding.paths.length ||
      ledger.entries.some(
        (entry, index) => entry.path !== this.binding.paths[index],
      )
    )
      return null;
    return ledger;
  }
}
