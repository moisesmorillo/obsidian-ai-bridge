import type { ConditionalCurrentNoteRepository } from "@core/mirror/conditional-current-note-repository.port";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_CONTENT_RESULT_KIND,
  CURRENT_NOTE_STATE_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  TOMBSTONE_WORKFLOW_STAGE_KIND,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalCreateRequest,
  ConditionalRecreateRequest,
  ConditionalTombstoneRequest,
  ConditionalUpdateRequest,
  ContentOperationReceipt,
  CurrentNoteState,
  MutationEffectResult,
  NotePage,
  RecoveryMutationResult,
  TombstoneOperationReceipt,
} from "@core/mirror/mirror.types";
import type {
  ConditionalContentWriteRequest,
  CurrentContentMutationResult,
  CurrentContentResult,
  MirrorGenerationCryptography,
  RecoveryPreparationProofResult,
  TombstoneMutationResult,
} from "@core/mirror/mirror-application.types";
import type {
  CurrentGenerationObservation,
  LiveCurrentGenerationCandidate,
  StoredLiveCurrentGeneration,
  StoredTombstoneCurrentGeneration,
} from "@core/mirror/mirror-storage.types";
import type { RecoveryService } from "@core/mirror/recovery-service";
import type { NotePath } from "@core/note-path/note-path.types";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";

/** Validates exact current-note text without normalization before hashing or dispatch.
 *
 * TextEncoder replaces unmatched UTF-16 surrogates; a round trip rejects that
 * replacement while preserving a leading U+FEFF as literal note content.
 *
 * @param content - Exact text candidate supplied by an adapter.
 * @returns Whether its well-formed UTF-8 representation fits the core note limit.
 */
export function isValidCurrentNoteContent(content: string): boolean {
  const bytes = new TextEncoder().encode(content);
  return (
    bytes.byteLength <= MAX_NOTE_SIZE_BYTES &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) ===
      content
  );
}

/**
 * Application policy for current-generation inspection and conditional transitions.
 *
 * Every matching mutation retains the exact observed storage CAS capability. The
 * service never refreshes a stale generation or reconstructs success from a later read.
 */
export class CurrentGenerationService {
  /**
   * @param repository - Current storage seam exposing only create-only and observed CAS.
   * @param recovery - Recovery lifecycle required before and after tombstone CAS.
   * @param cryptography - Exact digest and fresh application-revision dependencies.
   */
  constructor(
    private readonly repository: ConditionalCurrentNoteRepository,
    private readonly recovery: RecoveryService,
    private readonly cryptography: MirrorGenerationCryptography,
  ) {}

  /** @returns Metadata-only absent, legacy, live, or tombstone state. */
  async inspect(path: NotePath): Promise<CurrentNoteState> {
    return (await this.repository.read(path)).state;
  }

  /**
   * Reads one current generation while retaining metadata required by HTTP readers.
   *
   * @returns A closed one-read result without storage validators or replacement capability.
   */
  async readContent(path: NotePath): Promise<CurrentContentResult> {
    const observed = await this.repository.read(path);
    switch (observed.kind) {
      case CURRENT_NOTE_STATE_KIND.absent:
        return {
          kind: CURRENT_CONTENT_RESULT_KIND.absent,
          state: observed.state,
        };
      case CURRENT_NOTE_STATE_KIND.legacy:
        return {
          kind: CURRENT_CONTENT_RESULT_KIND.legacy,
          state: observed.state,
          content: observed.content,
        };
      case CURRENT_NOTE_STATE_KIND.live:
        return {
          kind: CURRENT_CONTENT_RESULT_KIND.live,
          state: observed.state,
          content: observed.content,
        };
      case CURRENT_NOTE_STATE_KIND.tombstone:
        return {
          kind: CURRENT_CONTENT_RESULT_KIND.tombstone,
          state: observed.state,
        };
    }
  }

  /**
   * Reads normal note content while hiding tombstones as unavailable.
   *
   * @returns Legacy/live Markdown, or `null` for absent and tombstone states.
   */
  async read(path: NotePath): Promise<string | null> {
    const result = await this.readContent(path);
    switch (result.kind) {
      case CURRENT_CONTENT_RESULT_KIND.absent:
      case CURRENT_CONTENT_RESULT_KIND.tombstone:
        return null;
      case CURRENT_CONTENT_RESULT_KIND.legacy:
      case CURRENT_CONTENT_RESULT_KIND.live:
        return result.content;
    }
  }

  /**
   * Lists one bounded page of visible live and legacy note paths.
   *
   * @param cursor - Opaque continuation from an earlier page.
   * @returns Visible paths only; tombstones are omitted without becoming absence evidence.
   */
  async list(cursor?: string): Promise<NotePage> {
    const page = await this.repository.list(cursor);
    const notes = page.states
      .filter(
        (state) =>
          state.kind === CURRENT_NOTE_STATE_KIND.live ||
          state.kind === CURRENT_NOTE_STATE_KIND.legacy,
      )
      .map((state) => state.path)
      .sort();
    return { notes, nextCursor: page.nextCursor };
  }

  /**
   * Applies one conditional content write using the observed generation to select its action.
   *
   * An absent precondition permits only create. A matching revision permits an update only
   * for a same-association live generation or recreation only for its same-association
   * tombstone. Legacy, absent, cross-association, or stale observations are refused without
   * a replacement dispatch; the exact observed storage capability remains the CAS authority.
   *
   * @param request - Explicit content, operation identity, association, and precondition.
   * @returns Exact confirmed acknowledgement or conservative effect certainty.
   */
  async writeConditionally(
    request: ConditionalContentWriteRequest,
  ): Promise<CurrentContentMutationResult> {
    if (!isValidCurrentNoteContent(request.content)) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    const precondition = request.precondition;
    if (precondition.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent) {
      return this.create({
        action: MUTATION_ACTION.create,
        associationId: request.associationId,
        writerId: request.writerId,
        operationId: request.operationId,
        path: request.path,
        precondition,
        content: request.content,
      });
    }

    const matchingWrite = {
      associationId: request.associationId,
      writerId: request.writerId,
      operationId: request.operationId,
      path: request.path,
      precondition,
      content: request.content,
    };
    let observed: CurrentGenerationObservation;
    try {
      observed = await this.repository.read(request.path);
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    switch (observed.kind) {
      case CURRENT_NOTE_STATE_KIND.live:
        return this.writeObservedGeneration(
          { action: MUTATION_ACTION.update, ...matchingWrite },
          observed,
          CURRENT_NOTE_STATE_KIND.live,
        );
      case CURRENT_NOTE_STATE_KIND.tombstone:
        return this.writeObservedGeneration(
          { action: MUTATION_ACTION.recreate, ...matchingWrite },
          observed,
          CURRENT_NOTE_STATE_KIND.tombstone,
        );
      case CURRENT_NOTE_STATE_KIND.absent:
      case CURRENT_NOTE_STATE_KIND.legacy:
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
    }
  }

  /**
   * Creates only after recognized absence and still uses atomic create-only storage.
   *
   * @param request - Exact create intent and UTF-8 Markdown body.
   * @returns The successful stored generation's exact acknowledgement or certainty.
   */
  async create(
    request: ConditionalCreateRequest,
  ): Promise<CurrentContentMutationResult> {
    if (!isValidCurrentNoteContent(request.content)) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const observed = await this.repository.read(request.path);
      if (observed.kind !== CURRENT_NOTE_STATE_KIND.absent) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }

      const contentSha256 = await this.cryptography.digest(request.content);
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
        contentSha256,
      } as const;
      const candidate: LiveCurrentGenerationCandidate = {
        kind: CURRENT_NOTE_STATE_KIND.live,
        revision: this.cryptography.generateRevision(),
        receipt,
        contentSha256,
        content: request.content,
      };
      return this.toAcknowledgement(
        await this.repository.create(request.path, candidate),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Updates only the exact observed live generation matching the original precondition.
   *
   * @param request - Original matching-revision intent and exact Markdown body.
   * @returns Exact successful acknowledgement; stale storage CAS is never retried.
   */
  async update(
    request: ConditionalUpdateRequest,
  ): Promise<CurrentContentMutationResult> {
    return this.writeMatchingLive(request, CURRENT_NOTE_STATE_KIND.live);
  }

  /**
   * Recreates only the exact observed tombstone and leaves recovery storage untouched.
   *
   * @param request - Original tombstone-revision intent and exact Markdown body.
   * @returns Exact successful acknowledgement; stale storage CAS is never retried.
   */
  async recreate(
    request: ConditionalRecreateRequest,
  ): Promise<CurrentContentMutationResult> {
    return this.writeMatchingLive(request, CURRENT_NOTE_STATE_KIND.tombstone);
  }

  /**
   * Prepares recovery, CAS-tombstones the exact live source, then attempts sealing.
   *
   * The current-object CAS is the deletion linearization point. Recovery uncertainty
   * prevents that CAS; sealing uncertainty after confirmation never undoes it.
   *
   * @param request - Original live-revision deletion intent.
   * @returns Separate current-head certainty and, on commit, independent sealing state.
   */
  async tombstone(
    request: ConditionalTombstoneRequest,
  ): Promise<TombstoneMutationResult> {
    let observed: CurrentGenerationObservation;
    try {
      observed = await this.repository.read(request.path);
    } catch {
      return {
        kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.current,
      };
    }
    if (
      observed.kind !== CURRENT_NOTE_STATE_KIND.live ||
      !this.matchesExistingGeneration(observed.state, request)
    ) {
      return {
        kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.current,
      };
    }

    let preparation: RecoveryPreparationProofResult;
    try {
      preparation = await this.recovery.prepareForDeletion({
        id: request.operationId,
        associationId: request.associationId,
        operationId: request.operationId,
        path: request.path,
        sourceRevision: observed.state.revision,
        contentSha256: observed.state.contentSha256,
        content: observed.content,
      });
    } catch {
      return {
        kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation,
      };
    }
    if (preparation.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return {
        kind: preparation.kind,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation,
      };
    }

    let tombstoneResult: MutationEffectResult<StoredTombstoneCurrentGeneration>;
    try {
      const receipt: TombstoneOperationReceipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
      };
      tombstoneResult = await observed.replacement.writeTombstone({
        kind: CURRENT_NOTE_STATE_KIND.tombstone,
        revision: this.cryptography.generateRevision(),
        receipt,
        deletedRevision: observed.state.revision,
        recoveryId: request.operationId,
      });
    } catch {
      return {
        kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.tombstone,
      };
    }
    if (tombstoneResult.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return {
        kind: tombstoneResult.kind,
        stage: TOMBSTONE_WORKFLOW_STAGE_KIND.tombstone,
      };
    }

    let sealing: RecoveryMutationResult;
    try {
      sealing = await this.recovery.sealConfirmedTombstone({
        preparation: preparation.confirmed,
        tombstone: tombstoneResult.confirmed,
        writerId: request.writerId,
        operationId: request.operationId,
      });
    } catch {
      sealing = { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.complete,
      confirmed: {
        acknowledgement: this.tombstoneAcknowledgement(
          tombstoneResult.confirmed.state,
        ),
        recovery: preparation.confirmed.state,
        sealing,
      },
    };
  }

  /**
   * Executes update/recreate policy against one retained observed generation.
   *
   * @param request - Exact content mutation request with its original precondition.
   * @param requiredKind - Current state that authorizes this mutation action.
   * @returns Exact stored acknowledgement or conservative effect certainty.
   */
  private async writeMatchingLive(
    request: ConditionalUpdateRequest | ConditionalRecreateRequest,
    requiredKind:
      | typeof CURRENT_NOTE_STATE_KIND.live
      | typeof CURRENT_NOTE_STATE_KIND.tombstone,
  ): Promise<CurrentContentMutationResult> {
    if (!isValidCurrentNoteContent(request.content)) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    let observed: CurrentGenerationObservation;
    try {
      observed = await this.repository.read(request.path);
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    return this.writeObservedGeneration(request, observed, requiredKind);
  }

  /**
   * Dispatches content replacement only through the exact observed generation's CAS.
   *
   * @param request - Action selected from the explicit current state and revision.
   * @param observed - One storage observation retaining its replacement capability.
   * @param requiredKind - State that authorizes the selected update or recreation.
   * @returns Exact stored acknowledgement or conservative effect certainty.
   */
  private async writeObservedGeneration(
    request: ConditionalUpdateRequest | ConditionalRecreateRequest,
    observed: CurrentGenerationObservation,
    requiredKind:
      | typeof CURRENT_NOTE_STATE_KIND.live
      | typeof CURRENT_NOTE_STATE_KIND.tombstone,
  ): Promise<CurrentContentMutationResult> {
    if (
      (observed.kind !== CURRENT_NOTE_STATE_KIND.live &&
        observed.kind !== CURRENT_NOTE_STATE_KIND.tombstone) ||
      observed.kind !== requiredKind ||
      !this.matchesExistingGeneration(observed.state, request)
    ) {
      return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
    }

    try {
      const contentSha256 = await this.cryptography.digest(request.content);
      const receipt: ContentOperationReceipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
        contentSha256,
      };
      const candidate: LiveCurrentGenerationCandidate = {
        kind: CURRENT_NOTE_STATE_KIND.live,
        revision: this.cryptography.generateRevision(),
        receipt,
        contentSha256,
        content: request.content,
      };
      return this.toAcknowledgement(
        await observed.replacement.writeLive(candidate),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Verifies that an established generation belongs to the requesting association.
   *
   * Association continuity is application policy: a matching revision from another
   * association never authorizes mutation or recovery preparation.
   *
   * @param state - Observed live or tombstone generation targeted by the mutation.
   * @param request - Matching-revision mutation carrying the active association.
   * @returns Whether both revision and association identify the expected generation.
   */
  private matchesExistingGeneration(
    state: Extract<CurrentNoteState, { readonly kind: "live" | "tombstone" }>,
    request:
      | ConditionalUpdateRequest
      | ConditionalRecreateRequest
      | ConditionalTombstoneRequest,
  ): boolean {
    return (
      state.revision === request.precondition.revision &&
      state.receipt.associationId === request.associationId
    );
  }

  /**
   * Maps only exact successful storage metadata to its persisted acknowledgement.
   *
   * @param result - Storage result tied directly to one conditional PUT.
   * @returns Public application certainty with storage capabilities removed.
   */
  private toAcknowledgement(
    result: MutationEffectResult<StoredLiveCurrentGeneration>,
  ): CurrentContentMutationResult {
    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return result;
    }
    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: this.contentAcknowledgement(result.confirmed.state),
    };
  }

  /**
   * Derives content-write evidence from the exact live state returned by a successful PUT.
   *
   * @param state - Exact confirmed live-generation metadata.
   * @returns Receipt-bearing acknowledgment that cannot represent a tombstone.
   */
  private contentAcknowledgement(state: StoredLiveCurrentGeneration["state"]) {
    return {
      path: state.path,
      revision: state.revision,
      receipt: state.receipt,
    };
  }

  /**
   * Derives tombstone evidence from the exact state returned by a successful delete PUT.
   *
   * @param state - Exact confirmed tombstone metadata.
   * @returns Receipt-bearing acknowledgment for the committed tombstone transition.
   */
  private tombstoneAcknowledgement(
    state: Extract<CurrentNoteState, { kind: "tombstone" }>,
  ) {
    return {
      path: state.path,
      revision: state.revision,
      receipt: state.receipt,
    };
  }
}
