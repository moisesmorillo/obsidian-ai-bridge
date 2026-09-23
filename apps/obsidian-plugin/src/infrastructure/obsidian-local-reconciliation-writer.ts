import {
  type ContentSha256,
  type CreateEligibleLocalRequest,
  type CreatePreservationLocalRequest,
  createReconciliationPreservationPath,
  currentPreservationNamespaceOverlapsConfig,
  evaluateLocalNotePath,
  evaluateLocalNoteSize,
  isCurrentReconciliationPreservationNamespacePath,
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_FAILURE,
  LOCAL_RECONCILIATION_REFUSAL,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
  LocalInspectionKind,
  type LocalReconciliationWriteCryptography,
  type LocalReconciliationWriteResult,
  type LocalReconciliationWriter,
  LocalSkipReason,
  MUTATION_EFFECT_CERTAINTY,
  RECONCILIATION_PRESERVATION_ROOT,
  type ReconciliationPreservationPath,
  type ReplaceEligibleLocalRequest,
} from "@obsidian-ai-bridge/core";
import type {
  ObsidianLocalReconciliationHost,
  ObsidianReconciliationFile,
  ObsidianReconciliationNode,
} from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer.types";

/** Private callback sentinel proving `Vault.process` refused before returning replacement text. */
const STALE_PROCESS_REFUSAL = Symbol("stale-local-reconciliation-content");

/**
 * Official-API adapter for the three narrow local reconciliation effects.
 *
 * Every content effect is create-only or atomic compare-and-replace and is followed
 * by an exact saved-file reread, UTF-8 size check, and SHA-256 verification. Host
 * exceptions after dispatch are never converted to “nothing happened”; they return
 * unknown effect certainty for restart reconciliation.
 */
export class ObsidianLocalReconciliationWriter<
  File extends ObsidianReconciliationFile,
> implements LocalReconciliationWriter
{
  /**
   * @param host - Narrow official Obsidian create/process/read boundary.
   * @param cryptography - Exact UTF-8 digest provider shared with reconciliation evidence.
   */
  constructor(
    private readonly host: ObsidianLocalReconciliationHost<File>,
    private readonly cryptography: LocalReconciliationWriteCryptography,
  ) {}

  /** @inheritdoc */
  async createEligible(
    request: CreateEligibleLocalRequest,
  ): Promise<LocalReconciliationWriteResult> {
    const pathFailure = this.eligiblePathFailure(request.path);
    if (pathFailure !== null) return pathFailure;
    const contentFailure = await this.contentFailure(
      request.content,
      request.contentSha256,
    );
    if (contentFailure !== null) return contentFailure;

    let existing: ObsidianReconciliationNode<File> | null;
    try {
      existing = this.host.lookup(request.path);
    } catch {
      return failedBeforeEffect();
    }
    if (existing?.kind === "folder") {
      return refused(LOCAL_RECONCILIATION_REFUSAL.destinationFolderExists);
    }
    if (existing?.kind === "file") {
      if (
        request.mode ===
        LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery
      ) {
        const exact = await this.inspectExact(
          request.path,
          existing.file,
          request.content,
          request.contentSha256,
        );
        if (exact.kind === "exact") {
          return confirmed(
            LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
            request.path,
            request.contentSha256,
            exact.sizeBytes,
          );
        }
        if (exact.kind === "unavailable") return failedBeforeEffect();
      }
      return refused(LOCAL_RECONCILIATION_REFUSAL.destinationFileExists);
    }

    const parents = await this.ensureEligibleParents(request.path);
    if (parents !== null) return parents;
    try {
      await this.host.create(request.path, request.content);
    } catch {
      return failedUnknown();
    }
    return this.verifyAfterEffect(
      request.path,
      request.content,
      request.contentSha256,
      LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
    );
  }

  /** @inheritdoc */
  async replaceEligible(
    request: ReplaceEligibleLocalRequest,
  ): Promise<LocalReconciliationWriteResult> {
    const pathFailure = this.eligiblePathFailure(request.path);
    if (pathFailure !== null) return pathFailure;
    const expectedFailure = await this.contentFailure(
      request.expectedContent,
      request.expectedContentSha256,
    );
    if (expectedFailure !== null) return expectedFailure;
    const replacementFailure = await this.contentFailure(
      request.replacementContent,
      request.replacementContentSha256,
    );
    if (replacementFailure !== null) return replacementFailure;

    let node: ObsidianReconciliationNode<File> | null;
    try {
      node = this.host.lookup(request.path);
    } catch {
      return failedBeforeEffect();
    }
    if (node === null) {
      return refused(LOCAL_RECONCILIATION_REFUSAL.missingTarget);
    }
    if (node.kind === "folder") {
      return refused(LOCAL_RECONCILIATION_REFUSAL.destinationFolderExists);
    }
    if (
      request.mode === LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery
    ) {
      const exactReplacement = await this.inspectExact(
        request.path,
        node.file,
        request.replacementContent,
        request.replacementContentSha256,
      );
      if (exactReplacement.kind === "exact") {
        return confirmed(
          LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
          request.path,
          request.replacementContentSha256,
          exactReplacement.sizeBytes,
        );
      }
      if (exactReplacement.kind === "unavailable") return failedBeforeEffect();
    }

    try {
      await this.host.process(node.file, (current) => {
        const currentNode = this.host.lookup(request.path);
        if (
          node.file.path !== request.path ||
          currentNode?.kind !== "file" ||
          currentNode.file !== node.file ||
          current !== request.expectedContent
        ) {
          throw STALE_PROCESS_REFUSAL;
        }
        return request.replacementContent;
      });
    } catch (error) {
      if (error === STALE_PROCESS_REFUSAL) {
        return refused(LOCAL_RECONCILIATION_REFUSAL.staleContent);
      }
      return failedUnknown();
    }
    return this.verifyAfterEffect(
      request.path,
      request.replacementContent,
      request.replacementContentSha256,
      LOCAL_RECONCILIATION_WRITE_OUTCOME.replaced,
    );
  }

  /** @inheritdoc */
  async createPreservation(
    request: CreatePreservationLocalRequest,
  ): Promise<LocalReconciliationWriteResult> {
    const path = createReconciliationPreservationPath(
      request.operationId,
      request.side,
      request.stepId,
    );
    if (path === undefined || !this.preservationRootIsSafe(path)) {
      return refused(LOCAL_RECONCILIATION_REFUSAL.unsafePreservationRoot);
    }
    const contentFailure = await this.contentFailure(
      request.content,
      request.contentSha256,
    );
    if (contentFailure !== null) return contentFailure;
    const operationFolder = `${RECONCILIATION_PRESERVATION_ROOT}/${request.operationId}`;
    const root = await this.ensurePreservationFolder(
      RECONCILIATION_PRESERVATION_ROOT,
      true,
    );
    if (root !== null) return root;
    const operation = await this.ensurePreservationFolder(
      operationFolder,
      request.stepId !== undefined ||
        request.mode ===
          LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
    );
    if (operation !== null) return operation;
    if (request.stepId !== undefined) {
      const step = await this.ensurePreservationFolder(
        `${operationFolder}/${request.stepId}`,
        request.mode ===
          LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      );
      if (step !== null) return step;
    }

    let existing: ObsidianReconciliationNode<File> | null;
    try {
      existing = this.host.lookup(path);
    } catch {
      return failedBeforeEffect();
    }
    if (existing !== null) {
      if (
        existing.kind === "file" &&
        request.mode ===
          LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery
      ) {
        const exact = await this.inspectExact(
          path,
          existing.file,
          request.content,
          request.contentSha256,
        );
        if (exact.kind === "exact") {
          return confirmed(
            LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
            path,
            request.contentSha256,
            exact.sizeBytes,
          );
        }
        if (exact.kind === "unavailable") return failedBeforeEffect();
      }
      return refused(LOCAL_RECONCILIATION_REFUSAL.preservationCollision);
    }
    try {
      await this.host.create(path, request.content);
    } catch {
      return failedUnknown();
    }
    return this.verifyAfterEffect(
      path,
      request.content,
      request.contentSha256,
      LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
    );
  }

  /**
   * Maps shared local path policy to write-specific typed refusals.
   *
   * @param path - Untrusted candidate destination.
   * @returns Null when eligible, otherwise a proven pre-effect refusal.
   */
  private eligiblePathFailure(
    path: string,
  ): LocalReconciliationWriteResult | null {
    const eligibility = evaluateLocalNotePath(path, this.host.policy);
    if (eligibility.kind === LocalInspectionKind.ok) return null;
    return refused(
      eligibility.reason === LocalSkipReason.excludedLocation
        ? LOCAL_RECONCILIATION_REFUSAL.excludedPath
        : LOCAL_RECONCILIATION_REFUSAL.invalidPath,
    );
  }

  /**
   * Verifies size and caller-supplied digest before any host effect.
   *
   * @param content - Exact transient text proposed for the effect.
   * @param expectedHash - Evidence-bound digest the text must match.
   * @returns Null when valid, otherwise a typed pre-effect failure.
   */
  private async contentFailure(
    content: string,
    expectedHash: ContentSha256,
  ): Promise<LocalReconciliationWriteResult | null> {
    const size = evaluateLocalNoteSize(
      new TextEncoder().encode(content).byteLength,
    );
    if (size.kind === LocalInspectionKind.failed) {
      return refused(LOCAL_RECONCILIATION_REFUSAL.oversized);
    }
    try {
      const hash = await this.cryptography.hashContent(content);
      return hash === expectedHash
        ? null
        : refused(LOCAL_RECONCILIATION_REFUSAL.contentHashMismatch);
    } catch {
      return failedBeforeEffect();
    }
  }

  /**
   * Creates each missing eligible parent component without path repair or fallback lookup.
   *
   * @param path - Already eligible destination whose parent components are required.
   * @returns Null when all parents exist, otherwise a typed refusal/failure.
   */
  private async ensureEligibleParents(
    path: string,
  ): Promise<LocalReconciliationWriteResult | null> {
    const segments = path.split("/").slice(0, -1);
    let parent = "";
    for (const segment of segments) {
      parent = parent.length === 0 ? segment : `${parent}/${segment}`;
      let node: ObsidianReconciliationNode<File> | null;
      try {
        node = this.host.lookup(parent);
      } catch {
        return failedBeforeEffect();
      }
      if (node?.kind === "file") {
        return refused(LOCAL_RECONCILIATION_REFUSAL.parentFileCollision);
      }
      if (node?.kind === "folder") continue;
      try {
        await this.host.createFolder(parent);
      } catch {
        return failedUnknown();
      }
      try {
        if (this.host.lookup(parent)?.kind !== "folder") return failedUnknown();
      } catch {
        return failedUnknown();
      }
    }
    return null;
  }

  /**
   * Creates one reserved folder or validates its permitted reuse.
   *
   * The root is reusable. The operation folder is reusable only during same-operation
   * recovery after a durable pending receipt exists.
   *
   * @param path - Exact reserved folder component.
   * @param mayReuse - Whether durable recovery authority permits an existing folder.
   * @returns Null when the folder is ready, otherwise a typed refusal/failure.
   */
  private async ensurePreservationFolder(
    path: string,
    mayReuse: boolean,
  ): Promise<LocalReconciliationWriteResult | null> {
    let node: ObsidianReconciliationNode<File> | null;
    try {
      node = this.host.lookup(path);
    } catch {
      return failedBeforeEffect();
    }
    if (node?.kind === "file") {
      return refused(LOCAL_RECONCILIATION_REFUSAL.preservationCollision);
    }
    if (node?.kind === "folder") {
      return mayReuse
        ? null
        : refused(LOCAL_RECONCILIATION_REFUSAL.preservationCollision);
    }
    try {
      await this.host.createFolder(path);
    } catch {
      return failedUnknown();
    }
    try {
      return this.host.lookup(path)?.kind === "folder" ? null : failedUnknown();
    } catch {
      return failedUnknown();
    }
  }

  /**
   * Proves the generated root cannot overlap config and remains mirror-ineligible without normalization.
   *
   * @param path - Generated preservation path to validate against host policy.
   * @returns Whether the root is private, excluded, and configuration-disjoint.
   */
  private preservationRootIsSafe(
    path: ReconciliationPreservationPath,
  ): boolean {
    if (
      currentPreservationNamespaceOverlapsConfig(
        this.host.policy.configDirectory,
      )
    ) {
      return false;
    }
    if (!isCurrentReconciliationPreservationNamespacePath(path)) return false;
    const eligibility = evaluateLocalNotePath(path, this.host.policy);
    return (
      eligibility.kind === LocalInspectionKind.failed &&
      eligibility.reason === LocalSkipReason.excludedLocation
    );
  }

  /**
   * Rereads an existing recovery candidate without treating mismatching bytes as an effect.
   *
   * @param path - Exact path whose identity must remain stable.
   * @param file - Captured host file identity.
   * @param expectedContent - Exact text required for adoption.
   * @param expectedHash - Expected digest of the same text.
   * @returns Exact byte evidence, a mismatch, or unavailable evidence.
   */
  private async inspectExact(
    path: string,
    file: File,
    expectedContent: string,
    expectedHash: ContentSha256,
  ): Promise<ExactInspection> {
    try {
      const content = await this.host.read(file);
      const current = this.host.lookup(path);
      if (
        file.path !== path ||
        current?.kind !== "file" ||
        current.file !== file
      ) {
        return { kind: "mismatch" };
      }
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      const size = evaluateLocalNoteSize(sizeBytes);
      if (size.kind === LocalInspectionKind.failed) return { kind: "mismatch" };
      const hash = await this.cryptography.hashContent(content);
      return content === expectedContent && hash === expectedHash
        ? { kind: "exact", sizeBytes }
        : { kind: "mismatch" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * Rereads the exact path and returns postcondition evidence only for exact text and digest.
   *
   * @param path - Exact affected destination.
   * @param expectedContent - Text that must now be saved.
   * @param expectedHash - Evidence-bound digest of the saved text.
   * @param outcome - Narrow effect reported after verification.
   * @returns Confirmed evidence or unknown postcondition failure.
   */
  private async verifyAfterEffect(
    path: CreateEligibleLocalRequest["path"] | ReconciliationPreservationPath,
    expectedContent: string,
    expectedHash: ContentSha256,
    outcome:
      | typeof LOCAL_RECONCILIATION_WRITE_OUTCOME.created
      | typeof LOCAL_RECONCILIATION_WRITE_OUTCOME.replaced,
  ): Promise<LocalReconciliationWriteResult> {
    try {
      const node = this.host.lookup(path);
      if (node?.kind !== "file") return failedUnknownPostcondition();
      const exact = await this.inspectExact(
        path,
        node.file,
        expectedContent,
        expectedHash,
      );
      if (exact.kind !== "exact") return failedUnknownPostcondition();
      return confirmed(outcome, path, expectedHash, exact.sizeBytes);
    } catch {
      return failedUnknownPostcondition();
    }
  }
}

/** Result of reading a possible same-operation artifact without changing it. */
type ExactInspection =
  | { readonly kind: "exact"; readonly sizeBytes: number }
  | { readonly kind: "mismatch" }
  | { readonly kind: "unavailable" };

/**
 * @param reason - Closed precondition reason proven before content effect.
 * @returns A proven no-effect precondition refusal.
 */
function refused(
  reason: (typeof LOCAL_RECONCILIATION_REFUSAL)[keyof typeof LOCAL_RECONCILIATION_REFUSAL],
): LocalReconciliationWriteResult {
  return {
    kind: "refused",
    reason,
    effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  };
}

/** @returns A host failure proven to occur before content dispatch. */
function failedBeforeEffect(): LocalReconciliationWriteResult {
  return {
    kind: "failed",
    reason: LOCAL_RECONCILIATION_FAILURE.hostUnavailable,
    effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  };
}

/** @returns A host failure after dispatch whose content effect cannot be inferred. */
function failedUnknown(): LocalReconciliationWriteResult {
  return {
    kind: "failed",
    reason: LOCAL_RECONCILIATION_FAILURE.hostUnavailable,
    effect: MUTATION_EFFECT_CERTAINTY.unknown,
  };
}

/** @returns A failed reread/hash proof after dispatch; the saved effect remains unknown. */
function failedUnknownPostcondition(): LocalReconciliationWriteResult {
  return {
    kind: "failed",
    reason: LOCAL_RECONCILIATION_FAILURE.postconditionMismatch,
    effect: MUTATION_EFFECT_CERTAINTY.unknown,
  };
}

/**
 * @param outcome - Verified narrow effect or exact same-operation adoption.
 * @param path - Exact post-verified destination.
 * @param contentSha256 - Digest of the reread text.
 * @param sizeBytes - Measured UTF-8 byte length of the reread text.
 * @returns Exact postcondition evidence from a saved-file reread.
 */
function confirmed(
  outcome: (typeof LOCAL_RECONCILIATION_WRITE_OUTCOME)[keyof typeof LOCAL_RECONCILIATION_WRITE_OUTCOME],
  path: CreateEligibleLocalRequest["path"] | ReconciliationPreservationPath,
  contentSha256: ContentSha256,
  sizeBytes: number,
): LocalReconciliationWriteResult {
  return { kind: "confirmed", outcome, path, contentSha256, sizeBytes };
}
