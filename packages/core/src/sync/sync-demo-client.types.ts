import type { ContentSha256 } from "@core/mirror/mirror.types";
import type {
  SyncDeviceId,
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
  SyncVaultId,
} from "@core/sync/sync.types";
import type { SyncMutationParent } from "@core/sync/sync-store.types";

/** Content-free acknowledged generation; its immutable bytes remain remote, never in the ledger. */
export interface SyncDemoBase {
  readonly revision: SyncRevision;
  readonly contentSha256: ContentSha256;
}
/** Original full-request identity surviving uncertain dispatch; body is reconstructed only from exact verified bytes. */
export interface SyncDemoPush {
  readonly kind: "push";
  /** Only explicit pre-journal refusal restricts reconstruction to unchanged saved bytes; uncertainty never proves absence. */
  readonly certainty: "uncertain" | "not_admitted";
  readonly operationId: SyncOperationId;
  readonly revision: SyncRevision;
  readonly parent: SyncMutationParent;
  readonly contentSha256: ContentSha256;
  /** Unix epoch milliseconds; a subsequent explicit invocation must respect this floor. */
  readonly retryAfterEpochMs: number;
  /** Separate shared-marker floor that must survive a new owner before any path spends a ticket. */
  readonly vaultRetryAfterEpochMs?: number | undefined;
}
/** Prepared local effect permits postcondition settlement after restart, not automatic redispatch. */
export interface SyncDemoApply {
  readonly kind: "apply";
  readonly target: SyncDemoBase;
  /** Null is create-only absence, otherwise the exact ACK hash whose bytes authorize replacement. */
  readonly expectedHash: ContentSha256 | null;
}
/** Durable competing version and verified preservation receipt; never advances the acknowledged base. */
export interface SyncDemoConflict {
  readonly kind: "conflict";
  readonly target: SyncDemoBase;
  /** Historical exact-copy verification, never permission to replace local bytes, advance the base or resolve the conflict. */
  readonly preserved: boolean;
}
/** One bounded path's acknowledged base and exclusive outstanding work; no body or credentials are representable. */
export interface SyncDemoEntry {
  readonly path: SyncNotePath;
  /** Null means no acknowledged generation, never remote absence or local deletion evidence. */
  readonly base: SyncDemoBase | null;
  /** Outstanding authority must settle or stop for review before any fresh intent is admitted. */
  readonly work: SyncDemoPush | SyncDemoApply | SyncDemoConflict | null;
}
/** Separate version-one experimental host-local state, never a migration of M3/M4 device data. */
export interface SyncDemoLedger {
  readonly schemaVersion: 1;
  readonly vaultId: SyncVaultId;
  readonly deviceId: SyncDeviceId;
  /** Canonical vault-bound feed checkpoint, zero-origin for fresh state and advanced only after complete durable page handling. */
  readonly cursor: string;
  readonly entries: readonly SyncDemoEntry[];
}
/** Configuration binding whose exact identity/path set must match persisted state before any effect. */
export interface SyncDemoClientBinding {
  readonly vaultId: SyncVaultId;
  readonly deviceId: SyncDeviceId;
  readonly paths: readonly SyncNotePath[];
}
/** Sanitized pass result; pending and attention never imply convergence or success. */
export type SyncDemoClientOutcome = "settled" | "pending" | "attention";
