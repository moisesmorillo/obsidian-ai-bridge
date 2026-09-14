import {
  CurrentGenerationService,
  createMirrorAssociationId,
  createMirrorWriterId,
  RecoveryService,
} from "@obsidian-ai-bridge/core";
import type { WorkerMirrorServices } from "@worker/app.types";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { R2ConditionalCurrentNoteRepository } from "@worker/infrastructure/r2-conditional-current-note.repository";
import { R2RecoverySnapshotRepository } from "@worker/infrastructure/r2-recovery-snapshot.repository";
import {
  generateApplicationRevision,
  sha256Content,
} from "@worker/storage/storage-crypto";

/** Minimal binding subset required to compose conditional mirror services. */
export interface WorkerMirrorEnvironment {
  /** R2 capability used by current and recovery adapters. */
  readonly VAULT_BUCKET: R2ConditionalBucketPort;
  /** Untrusted non-secret association configuration. */
  readonly MIRROR_ASSOCIATION_ID?: string;
  /** Untrusted non-secret designated-writer configuration. */
  readonly MIRROR_WRITER_ID?: string;
}

/**
 * Composes request-scoped M3 services over one active R2 binding.
 *
 * Configuration IDs are validated here before entering handlers or application
 * services. Invalid or missing IDs leave reads available while every mutation
 * fails closed at the designation guard.
 *
 * @param environment - Active Worker bindings for one request.
 * @returns Current/recovery services and optional validated designation.
 */
export function resolveWorkerMirrorServices(
  environment: WorkerMirrorEnvironment,
): WorkerMirrorServices {
  const currentRepository = new R2ConditionalCurrentNoteRepository(
    environment.VAULT_BUCKET,
  );
  const recoveryRepository = new R2RecoverySnapshotRepository(
    environment.VAULT_BUCKET,
  );
  const cryptography = {
    digest: sha256Content,
    generateRevision: generateApplicationRevision,
  };
  const recovery = new RecoveryService(
    recoveryRepository,
    currentRepository,
    cryptography,
    { now: () => new Date() },
  );
  const associationId = createMirrorAssociationId(
    environment.MIRROR_ASSOCIATION_ID ?? "",
  );
  const writerId = createMirrorWriterId(environment.MIRROR_WRITER_ID ?? "");

  return {
    current: new CurrentGenerationService(
      currentRepository,
      recovery,
      cryptography,
    ),
    recovery,
    designation:
      associationId === undefined || writerId === undefined
        ? null
        : { associationId, writerId },
  };
}
