import {
  type ConditionalMutationPrecondition,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  HANDOFF_ALIGNMENT_KIND,
  isMirrorDeviceStateV2Consistent,
  isNormalizedNotePath,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_DEVICE_STATE_V2_VERSION,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorAcknowledgement,
  type MirrorDesiredState,
  type MirrorDeviceLifecycle,
  type MirrorDeviceStateV2,
  type MirrorPathState,
  MUTATION_ACTION,
  type NotePath,
  type StagedHandoff,
  type TransferableAcknowledgement,
  type UnresolvedMutationIntent,
} from "@obsidian-ai-bridge/core";
import { unresolvedMutationIntentSchema } from "@obsidian-ai-bridge/protocol";
import { parsePersistedMirrorOrigin } from "@obsidian-plugin/configuration/mirror-endpoint";
import {
  type HandoffIntegrity,
  verifyHandoffPayloadChecksum,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import { z } from "zod";

/** Frozen M3 serialized format identifier used only for version-2 migration. */
const MIRROR_DEVICE_STATE_V2_FORMAT = "obsidian-ai-bridge-device-state";

/** Frozen M3 maximum accepted version-2 snapshot size. */
const MAX_MIRROR_DEVICE_STATE_V2_BYTES = 8 * 1024 * 1024;

/** Strict host-local decode result; incompatible data is never treated as missing. */
export type MirrorDeviceStateV2DecodeResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly state: MirrorDeviceStateV2 }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unsupported-version"; readonly version: number };

const acknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.live),
      revision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone),
      revision: z.string(),
      recoveryId: z.string(),
    })
    .strict(),
]);

const desiredStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(MIRROR_DESIRED_STATE_KIND.none) }).strict(),
  z
    .object({
      kind: z.literal(MIRROR_DESIRED_STATE_KIND.dirtyPresent),
      observationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DESIRED_STATE_KIND.runtimeDelete),
      observationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
      evidenceId: z.string(),
      associationId: z.string(),
      expectedRevision: z.string(),
      graceDeadlineMilliseconds: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DESIRED_STATE_KIND.renameDeferred),
      observationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
      renameId: z.string(),
      associationId: z.string(),
      sourcePath: z.string(),
      destinationPath: z.string().nullable(),
      sourceExpectedRevision: z.string(),
      destinationObservationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .nullable(),
      destinationAcknowledgedRevision: z.string().nullable(),
      graceDeadlineMilliseconds: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
      phase: z.enum([
        MIRROR_RENAME_PHASE.destinationRequired,
        MIRROR_RENAME_PHASE.sourceCleanupRequired,
        MIRROR_RENAME_PHASE.invalidated,
      ]),
    })
    .strict(),
]);

const pathStateSchema = z
  .object({
    path: z.string(),
    acknowledgement: acknowledgementSchema,
    unresolvedMutation: z
      .object({
        intent: unresolvedMutationIntentSchema,
        phase: z.enum([
          MIRROR_MUTATION_PHASE.intentPersisted,
          MIRROR_MUTATION_PHASE.dispatched,
          MIRROR_MUTATION_PHASE.evidenceRequired,
          MIRROR_MUTATION_PHASE.recoveryPreparation,
          MIRROR_MUTATION_PHASE.tombstoneCommit,
        ]),
      })
      .strict()
      .nullable(),
    desired: desiredStateSchema,
    blockedReason: z
      .enum([
        MIRROR_PATH_BLOCK_REASON.diverged,
        MIRROR_PATH_BLOCK_REASON.retryExhausted,
        MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
        MIRROR_PATH_BLOCK_REASON.renameDeferred,
        MIRROR_PATH_BLOCK_REASON.handoffMismatch,
      ])
      .nullable(),
  })
  .strict();

const bindingFields = {
  associationId: z.string(),
  origin: z.string().min(1).max(2048),
};
const lifecycleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.disabled) }).strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.active),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.paused),
      ...bindingFields,
      reason: z.enum([
        MIRROR_PAUSE_REASON.manual,
        MIRROR_PAUSE_REASON.persistenceFailure,
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged),
      ...bindingFields,
    })
    .strict(),
]);

const transferableAcknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.live),
      revision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone),
      revision: z.string(),
      recoveryId: z.string(),
    })
    .strict(),
]);
const stagedHandoffSchema = z
  .object({
    associationId: z.string(),
    origin: z.string().min(1).max(2048),
    checksum: z.string(),
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            acknowledgement: transferableAcknowledgementSchema,
            localAlignment: z.enum([
              HANDOFF_ALIGNMENT_KIND.pending,
              HANDOFF_ALIGNMENT_KIND.matched,
              HANDOFF_ALIGNMENT_KIND.mismatch,
            ]),
            remoteVerification: z.enum([
              HANDOFF_ALIGNMENT_KIND.pending,
              HANDOFF_ALIGNMENT_KIND.matched,
              HANDOFF_ALIGNMENT_KIND.mismatch,
            ]),
            observationGeneration: z
              .number()
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(MAX_MIRROR_TRACKED_PATHS),
  })
  .strict();

const deviceStateSchema = z
  .object({
    format: z.literal(MIRROR_DEVICE_STATE_V2_FORMAT),
    version: z.literal(MIRROR_DEVICE_STATE_V2_VERSION),
    deviceId: z.string(),
    lifecycle: lifecycleSchema,
    globalBlockReason: z
      .enum([
        MIRROR_GLOBAL_BLOCK_REASON.configurationUnavailable,
        MIRROR_GLOBAL_BLOCK_REASON.stateUnavailable,
        MIRROR_GLOBAL_BLOCK_REASON.persistenceFailed,
        MIRROR_GLOBAL_BLOCK_REASON.designationMismatch,
        MIRROR_GLOBAL_BLOCK_REASON.missingSecret,
        MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch,
        MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable,
      ])
      .nullable(),
    paths: z.array(pathStateSchema).max(MAX_MIRROR_TRACKED_PATHS),
    stagedHandoff: stagedHandoffSchema.nullable(),
  })
  .strict();
const stateHeaderSchema = z
  .object({
    format: z.literal(MIRROR_DEVICE_STATE_V2_FORMAT),
    version: z.number().int(),
  })
  .loose();

type DeviceStateDto = z.infer<typeof deviceStateSchema>;
type PathStateDto = z.infer<typeof pathStateSchema>;
type AcknowledgementDto = z.infer<typeof acknowledgementSchema>;
type DesiredStateDto = z.infer<typeof desiredStateSchema>;
type LifecycleDto = z.infer<typeof lifecycleSchema>;
type StagedHandoffDto = z.infer<typeof stagedHandoffSchema>;
type TransferableAcknowledgementDto = z.infer<
  typeof transferableAcknowledgementSchema
>;

/**
 * Strictly decodes one value returned by `App.loadLocalStorage`.
 *
 * @param stored - Untrusted host-local value.
 * @param integrity - Adapter-owned checksum capability for staged baselines.
 * @returns Missing, valid, corrupt, or unsupported-future outcome.
 * @throws When staged-baseline integrity cannot be evaluated by the host.
 */
export async function decodeMirrorDeviceStateV2(
  stored: unknown,
  integrity: HandoffIntegrity = new WebCryptoHandoffIntegrity(),
): Promise<MirrorDeviceStateV2DecodeResult> {
  if (stored === null || stored === undefined) return { kind: "missing" };
  if (typeof stored !== "string") return { kind: "corrupt" };
  if (byteLength(stored) > MAX_MIRROR_DEVICE_STATE_V2_BYTES) {
    return { kind: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { kind: "corrupt" };
  }
  const header = stateHeaderSchema.safeParse(parsed);
  if (
    header.success &&
    header.data.version !== MIRROR_DEVICE_STATE_V2_VERSION
  ) {
    return { kind: "unsupported-version", version: header.data.version };
  }
  const decoded = deviceStateSchema.safeParse(parsed);
  if (!decoded.success) return { kind: "corrupt" };
  let state: MirrorDeviceStateV2;
  try {
    state = convertDeviceState(decoded.data);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isMirrorDeviceStateV2Consistent(state)) return { kind: "corrupt" };
  if (state.stagedHandoff !== null) {
    const checksumMatches = await verifyHandoffPayloadChecksum(
      {
        associationId: state.stagedHandoff.associationId,
        origin: state.stagedHandoff.origin,
        entries: state.stagedHandoff.entries.map((entry) => ({
          path: entry.path,
          acknowledgement: entry.acknowledgement,
        })),
      },
      state.stagedHandoff.checksum,
      integrity,
    );
    if (!checksumMatches) return { kind: "corrupt" };
  }
  return { kind: "valid", state };
}

function convertDeviceState(dto: DeviceStateDto): MirrorDeviceStateV2 {
  return {
    deviceId: requireParsed(dto.deviceId, createMirrorWriterId),
    lifecycle: convertLifecycle(dto.lifecycle),
    globalBlockReason: dto.globalBlockReason,
    paths: dto.paths.map(convertPathState),
    stagedHandoff:
      dto.stagedHandoff === null
        ? null
        : convertStagedHandoff(dto.stagedHandoff),
  };
}

function convertLifecycle(dto: LifecycleDto): MirrorDeviceLifecycle {
  if (dto.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) return dto;
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const origin = requireParsed(dto.origin, parsePersistedMirrorOrigin);
  if (dto.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused) {
    return { kind: dto.kind, associationId, origin, reason: dto.reason };
  }
  return { kind: dto.kind, associationId, origin };
}

function convertPathState(dto: PathStateDto): MirrorPathState {
  const path = requireParsed(dto.path, parsePersistedNotePath);
  return {
    path,
    acknowledgement: convertAcknowledgement(dto.acknowledgement),
    unresolvedMutation:
      dto.unresolvedMutation === null
        ? null
        : {
            intent: convertUnresolvedMutation(dto.unresolvedMutation.intent),
            phase: dto.unresolvedMutation.phase,
          },
    desired: convertDesiredState(dto.desired),
    blockedReason: dto.blockedReason,
  };
}

function convertAcknowledgement(
  dto: AcknowledgementDto,
): MirrorAcknowledgement {
  if (dto.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) return dto;
  const revision = requireParsed(dto.revision, createApplicationRevision);
  if (dto.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return {
      kind: dto.kind,
      revision,
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    };
  }
  return {
    kind: dto.kind,
    revision,
    recoveryId: requireParsed(dto.recoveryId, createRecoverySnapshotId),
  };
}

function convertDesiredState(dto: DesiredStateDto): MirrorDesiredState {
  if (
    dto.kind === MIRROR_DESIRED_STATE_KIND.none ||
    dto.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent
  ) {
    return dto;
  }
  if (dto.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
    return {
      ...dto,
      evidenceId: requireParsed(dto.evidenceId, createMirrorOperationId),
      associationId: requireParsed(
        dto.associationId,
        createMirrorAssociationId,
      ),
      expectedRevision: requireParsed(
        dto.expectedRevision,
        createApplicationRevision,
      ),
    };
  }
  return {
    ...dto,
    renameId: requireParsed(dto.renameId, createMirrorOperationId),
    associationId: requireParsed(dto.associationId, createMirrorAssociationId),
    sourcePath: requireParsed(dto.sourcePath, parsePersistedNotePath),
    destinationPath:
      dto.destinationPath === null
        ? null
        : requireParsed(dto.destinationPath, parsePersistedNotePath),
    sourceExpectedRevision: requireParsed(
      dto.sourceExpectedRevision,
      createApplicationRevision,
    ),
    destinationAcknowledgedRevision:
      dto.destinationAcknowledgedRevision === null
        ? null
        : requireParsed(
            dto.destinationAcknowledgedRevision,
            createApplicationRevision,
          ),
  };
}

function convertUnresolvedMutation(
  dto: z.infer<typeof unresolvedMutationIntentSchema>,
): UnresolvedMutationIntent {
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const writerId = requireParsed(dto.writerId, createMirrorWriterId);
  const operationId = requireParsed(dto.operationId, createMirrorOperationId);
  const path = requireParsed(dto.path, parsePersistedNotePath);
  if (dto.action === MUTATION_ACTION.create) {
    return {
      action: dto.action,
      associationId,
      writerId,
      operationId,
      path,
      precondition: { kind: "absent" },
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
      mutationAttempts: dto.mutationAttempts,
      evidenceAttempts: dto.evidenceAttempts,
    };
  }
  const precondition = convertMatchingPrecondition(dto.precondition);
  if (dto.action === MUTATION_ACTION.tombstone) {
    return {
      action: dto.action,
      associationId,
      writerId,
      operationId,
      path,
      precondition,
      mutationAttempts: dto.mutationAttempts,
      evidenceAttempts: dto.evidenceAttempts,
    };
  }
  return {
    action: dto.action,
    associationId,
    writerId,
    operationId,
    path,
    precondition,
    contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    mutationAttempts: dto.mutationAttempts,
    evidenceAttempts: dto.evidenceAttempts,
  };
}

function convertMatchingPrecondition(
  dto: z.infer<typeof unresolvedMutationIntentSchema>["precondition"],
): Exclude<ConditionalMutationPrecondition, { readonly kind: "absent" }> {
  if (dto.kind === "absent") throw new Error("Expected matching revision.");
  return {
    kind: dto.kind,
    revision: requireParsed(dto.revision, createApplicationRevision),
  };
}

function convertStagedHandoff(dto: StagedHandoffDto): StagedHandoff {
  return {
    associationId: requireParsed(dto.associationId, createMirrorAssociationId),
    origin: requireParsed(dto.origin, parsePersistedMirrorOrigin),
    checksum: requireParsed(dto.checksum, createContentSha256),
    entries: dto.entries.map((entry) => ({
      path: requireParsed(entry.path, parsePersistedNotePath),
      acknowledgement: convertTransferableAcknowledgement(
        entry.acknowledgement,
      ),
      localAlignment: entry.localAlignment,
      remoteVerification: entry.remoteVerification,
      observationGeneration: entry.observationGeneration,
    })),
  };
}

function convertTransferableAcknowledgement(
  dto: TransferableAcknowledgementDto,
): TransferableAcknowledgement {
  const acknowledgement = convertAcknowledgement(dto);
  if (acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) {
    throw new Error("Unassociated acknowledgement is not transferable.");
  }
  return acknowledgement;
}

/**
 * @param value - Persisted literal local path.
 * @returns The path unchanged after validating its literal form.
 */
function parsePersistedNotePath(value: string): NotePath | undefined {
  return isNormalizedNotePath(value) ? value : undefined;
}

function requireParsed<Value>(
  value: string,
  parser: (candidate: string) => Value | undefined,
): Value {
  const parsed = parser(value);
  if (parsed === undefined) throw new Error("Invalid persisted identifier.");
  return parsed;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
