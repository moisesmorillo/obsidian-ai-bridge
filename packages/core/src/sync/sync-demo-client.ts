import type { SyncNotePath } from "@core/sync/sync.types";
import type {
  SyncDemoClientEnvironment,
  SyncDemoLedgerStore,
  SyncDemoLocal,
  SyncDemoRemote,
} from "@core/sync/sync-demo-client.port";
import type {
  SyncDemoClientOutcome,
  SyncDemoEntry,
} from "@core/sync/sync-demo-client.types";
import {
  hashSyncDemoContent,
  isSyncDemoContent,
  SyncDemoClientEffects,
} from "@core/sync/sync-demo-client-effects";
import type { SyncStoreFailure } from "@core/sync/sync-store.types";

/** Classifies observation failures without manufacturing settled absence or repairing an invalid cursor.
 * @param code Typed store certainty; mutation-not-admitted is handled only by original-request execution.
 * @returns Pending only for transient evidence failure; other refusals require attention.
 */
function observationFailureOutcome(
  code: SyncStoreFailure["code"],
): Exclude<SyncDemoClientOutcome, "settled"> {
  switch (code) {
    case "storage_unavailable":
    case "storage_throttled":
    case "effect_unknown":
    case "operation_pending":
      return "pending";
    default:
      return "attention";
  }
}

/** Retains the strongest unsatisfied result without preventing independent bound paths from progressing.
 * @param previous Aggregate result of paths already reconciled.
 * @param current Result of the next independent path.
 * @returns Attention before pending before settled, without claiming feed settlement.
 */
function combineOutcomes(
  previous: SyncDemoClientOutcome,
  current: SyncDemoClientOutcome,
): SyncDemoClientOutcome {
  if (previous === "attention" || current === "attention") return "attention";
  if (previous === "pending" || current === "pending") return "pending";
  return "settled";
}

/** One serialized exact-base coordinator; delivery 3 must retain this owner across replacement sessions and fence stale host dispatch. */
export class SyncDemoClient {
  /** Command exclusion lasts through effect and persistence settlement, not merely the calling UI session. */
  private tail: Promise<SyncDemoClientOutcome> = Promise.resolve("pending");
  /** Binds narrow ports to one explicitly armed synthetic lab; no constructor starts work or attaches release runtime. */
  constructor(
    private readonly store: SyncDemoLedgerStore,
    private readonly local: SyncDemoLocal,
    private readonly remote: SyncDemoRemote,
    private readonly environment: SyncDemoClientEnvironment,
  ) {}
  /** Runs finite positive reconciliation followed by one feed page; overlapping commands serialize without duplicate identities.
   * @returns Sanitized settled/pending/attention result, never an optimistic transport ACK.
   */
  syncNow(): Promise<SyncDemoClientOutcome> {
    const pass = this.tail.then(() => this.runPass());
    this.tail = pass;
    return pass;
  }
  /** Rehydrates every pass; persistence/boundary failure returns sanitized attention and cannot initialize empty authority.
   * @returns Finite pass outcome after durable entry/page settlement or a closed safety barrier.
   */
  private async runPass(): Promise<SyncDemoClientOutcome> {
    try {
      const loaded = await this.store.load();
      if (loaded.kind !== "ready") return "attention";
      const ledger = loaded.ledger;
      const binding = this.environment.binding;
      if (
        ledger.vaultId !== binding.vaultId ||
        ledger.deviceId !== binding.deviceId ||
        ledger.entries.length !== binding.paths.length ||
        ledger.entries.some(
          (entry, index) => entry.path !== binding.paths[index],
        )
      )
        return "attention";
      const vaultFloor = Math.max(
        0,
        ...ledger.entries.map((entry) =>
          entry.work?.kind === "push"
            ? (entry.work.vaultRetryAfterEpochMs ?? 0)
            : 0,
        ),
      );
      if (this.environment.now() < vaultFloor) return "pending";
      this.remote.beginPass();
      const effects = new SyncDemoClientEffects(
        ledger,
        this.store,
        this.local,
        this.remote,
        this.environment,
      );
      let outcome: SyncDemoClientOutcome = "settled";
      for (const path of binding.paths) {
        const pathOutcome = await this.reconcile(path, effects);
        outcome = combineOutcomes(outcome, pathOutcome);
      }
      if (outcome !== "settled") return outcome;
      const page = await this.remote.changes(effects.state.cursor);
      if (page.kind !== "page") return observationFailureOutcome(page.code);
      const paths = new Set<SyncNotePath>();
      for (const event of page.events) {
        if (event.kind !== "changed") continue;
        if (
          !binding.paths.includes(event.path) ||
          event.result.kind === "tombstone"
        )
          return "attention";
        paths.add(event.path);
      }
      for (const path of paths) {
        const pathOutcome = await this.reconcile(path, effects);
        outcome = combineOutcomes(outcome, pathOutcome);
      }
      if (outcome !== "settled") return outcome;
      return (await effects.saveCursor(page.nextCursor))
        ? "settled"
        : "attention";
    } catch {
      return "attention";
    }
  }
  /** Pulls before a fresh push and classifies exact local/base/current evidence; historical events only select this fresh read.
   * @param path Explicit synthetic path already bound to the ledger.
   * @param effects Sole prepared-effect/persistence owner for this pass.
   * @returns Durable classification without latest-parent overwrite or scan-derived deletion.
   */
  private async reconcile(
    path: SyncNotePath,
    effects: SyncDemoClientEffects,
  ): Promise<SyncDemoClientOutcome> {
    const entry = effects.state.entries.find(
      (candidate) => candidate.path === path,
    );
    if (entry === undefined) return "attention";
    if (entry.work !== null) {
      /** Exhaustive recovery ownership: adding a durable work kind cannot silently fall through to fresh-effect admission. */
      const recover: {
        [Kind in NonNullable<
          SyncDemoEntry["work"]
        >["kind"]]: () => Promise<SyncDemoClientOutcome>;
      } = {
        push: () => effects.recoverPush(entry),
        apply: () => effects.recoverApply(entry),
        conflict: () => effects.recoverConflict(entry),
      };
      return recover[entry.work.kind]();
    }
    const local = await this.local.observe(path);
    if (
      local.kind === "blocked" ||
      (local.kind === "live" && !isSyncDemoContent(local.content))
    )
      return "attention";
    const current = await this.remote.current(path);
    if (current.kind === "error") {
      // Fresh namespace reads cannot prepare its marker. An original create CAS is non-overwriting even when absence is not established.
      if (
        entry.base === null &&
        local.kind === "live" &&
        current.code === "storage_unavailable"
      )
        return effects.push(entry, local.content);
      return observationFailureOutcome(current.code);
    }
    if (current.kind === "tombstone") return "attention";
    if (current.kind === "never_seen") {
      if (entry.base !== null) return "attention";
      return local.kind === "absent"
        ? "settled"
        : effects.push(entry, local.content);
    }
    const version = await effects.version(path, current, current);
    if (version === null) return "attention";
    if (entry.base === null)
      return local.kind === "absent"
        ? effects.apply(entry, version, null)
        : effects.conflict(entry, version);
    if (local.kind === "absent") return "attention";
    const localHash = await hashSyncDemoContent(local.content);
    if (current.revision === entry.base.revision) {
      if (current.contentSha256 !== entry.base.contentSha256)
        return "attention";
      return localHash === entry.base.contentSha256
        ? "settled"
        : effects.push(entry, local.content);
    }
    if (localHash !== entry.base.contentSha256)
      return effects.conflict(entry, version);
    const base = await effects.version(path, entry.base);
    if (base === null || base.content !== local.content) return "attention";
    return effects.apply(entry, version, base.content);
  }
}
