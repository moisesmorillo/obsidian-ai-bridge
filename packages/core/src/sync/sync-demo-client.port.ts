import type {
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
} from "@core/sync/sync.types";
import type {
  SyncDemoClientBinding,
  SyncDemoLedger,
} from "@core/sync/sync-demo-client.types";
import type {
  SyncMutationRequest,
  SyncMutationResult,
  SyncReadChangesResult,
  SyncReadCurrentResult,
  SyncReadVersionResult,
} from "@core/sync/sync-store.types";

/** Persistence authority; a failed save fences this owner until a new verified load in a new owner. */
export interface SyncDemoLedgerStore {
  /** Rehydrates exact bound state, or durably initializes only genuinely absent storage at the zero cursor. */
  load(): Promise<
    | { readonly kind: "ready"; readonly ledger: SyncDemoLedger }
    | { readonly kind: "blocked" }
  >;
  /** Writes and read-back verifies the entire strict ledger before publishing a transition. */
  save(ledger: SyncDemoLedger): Promise<boolean>;
}
/** Host-local serialized storage seam; no filesystem, shared data.json or synced vault file is implied. */
export interface SyncDemoStringStorage {
  /** Null denotes positively observed missing state, not an unavailable read. */
  read(): Promise<string | null>;
  /** Persists one bounded string; verification belongs to the repository adapter. */
  write(serialized: string): Promise<void>;
}
/** Narrow remote revision-domain capabilities; every pass is finite and authentication remains adapter-owned. */
export interface SyncDemoRemote {
  /** Starts a serialized pass's fresh request budget, never an independent retry loop. */
  beginPass(): void;
  /** Returns exact live metadata or verified absence/failure, never fabricated empty success. */
  current(path: SyncNotePath): Promise<SyncReadCurrentResult>;
  /** Returns exact immutable bytes and identity for coordinator linkage verification. */
  version(revision: SyncRevision): Promise<SyncReadVersionResult>;
  /** Replays the entire original request; only committed is acknowledgment authority. */
  mutate(
    request: Exclude<SyncMutationRequest, { readonly kind: "tombstone" }>,
  ): Promise<SyncMutationResult>;
  /** Reads one original-cursor page; corrupt or expired cursors are not repaired. */
  changes(cursor: string): Promise<SyncReadChangesResult>;
}
/** Fresh positive observations after complete metadata alias/folder/exclusion preflight, not scan-derived deletions. */
export type SyncDemoLocalObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "live"; readonly content: string }
  | { readonly kind: "blocked" };
/** Local host capability contract; delivery 3 supplies official Vault, listener-ready dispatch/session fencing and postcondition reads. */
export interface SyncDemoLocal {
  /** Checks whole-vault metadata for ambiguity and reads saved bytes; stale/unavailable coverage returns blocked. */
  observe(path: SyncNotePath): Promise<SyncDemoLocalObservation>;
  /** Create-only for null expected bytes, otherwise atomic exact-byte compare-and-replace; rechecks admission immediately at dispatch. */
  apply(
    path: SyncNotePath,
    expected: string | null,
    content: string,
  ): Promise<"applied" | "refused" | "unknown">;
  /** Create-only exact competing version under excluded ai-bridge-conflicts; the path/revision tuple names the same copy across retries/restart, and collisions never overwrite. */
  preserve(
    path: SyncNotePath,
    revision: SyncRevision,
    content: string,
  ): Promise<void>;
  /** Rereads the same generated excluded copy; null or thrown unavailability cannot verify preservation and never grants publication. */
  preserved(path: SyncNotePath, revision: SyncRevision): Promise<string | null>;
}
/** Injected deterministic identities and epoch clock; platforms never grant mutation authority through time alone. */
export interface SyncDemoClientEnvironment {
  readonly binding: SyncDemoClientBinding;
  /** Returns current Unix epoch milliseconds for retry admission. */
  now(): number;
  /** Allocates a fresh operation identity once before durable request admission. */
  operationId(): SyncOperationId;
  /** Allocates a fresh immutable target revision once before durable request admission. */
  revision(): SyncRevision;
}
