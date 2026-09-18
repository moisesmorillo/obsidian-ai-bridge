import type {
  CreateEligibleLocalRequest,
  CreatePreservationLocalRequest,
  LocalReconciliationWriteResult,
  ReplaceEligibleLocalRequest,
} from "@core/mirror/local-reconciliation-writer.types";

/**
 * Narrow local effect port for exact M4 note creation, comparison replacement, and preservation.
 *
 * It deliberately exposes no generic write, host object, rename, move, trash, or delete
 * capability. Core authorizes every request from a durable operation before invoking
 * this boundary; adapters enforce host collisions, atomic comparison, and reread proof.
 */
export interface LocalReconciliationWriter {
  /** Creates one eligible note only at exact absence, then rereads and verifies its bytes. */
  createEligible(
    request: CreateEligibleLocalRequest,
  ): Promise<LocalReconciliationWriteResult>;

  /** Atomically replaces one eligible file only when current text equals the sampled text, then rereads and verifies it. */
  replaceEligible(
    request: ReplaceEligibleLocalRequest,
  ): Promise<LocalReconciliationWriteResult>;

  /** Creates or same-operation-adopts one generated excluded preservation artifact and proves its exact bytes. */
  createPreservation(
    request: CreatePreservationLocalRequest,
  ): Promise<LocalReconciliationWriteResult>;
}
