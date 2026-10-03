import type { SyncStore } from "@core/sync/sync-store.port";
import type { SyncR2CallBudget } from "@worker/infrastructure/sync/sync-r2.types";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import type { SyncR2Records } from "@worker/infrastructure/sync/sync-r2-records";

/** Server-supplied Unix epoch milliseconds used only for durable retry timing. */
export type SyncServerClock = () => number;

/** One mutation invocation's shared records/publication capabilities and actual-call budget. */
export interface SyncR2MutationInvocationCapabilities {
  /** Marker-gated record operations sharing this invocation's R2 object store. */
  readonly records: SyncR2Records;
  /** Journal, lane, and event operations sharing the same R2 object store. */
  readonly publication: SyncR2Publication;
  /** Actual GET/PUT accounting for all capabilities in this invocation. */
  readonly callBudget: SyncR2CallBudget;
}

/** Creates a fresh shared capability pair and budget for one mutate or resume call. */
export type SyncR2MutationInvocationFactory =
  () => SyncR2MutationInvocationCapabilities;

/** Mutation and exact-read methods composed into the private sync R2 store. */
export type SyncR2MutationStore = Pick<
  SyncStore,
  "mutate" | "resumeOperation" | "readCurrent" | "readVersion" | "readRecovery"
>;
