import {
  HISTORY_DECISION_KIND,
  type MirrorOperationId,
  RECONCILIATION_ACTION,
  type ReconciliationAdmissionAction,
} from "@obsidian-ai-bridge/core";
import type {
  ReconciliationGapActionSelection,
  ReconciliationGapReviewDetail,
  ReconciliationObservationGapCandidate,
  ReconciliationUiCommandResult,
  ReconciliationUiOwner,
} from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { type App, Modal } from "obsidian";

/** Text-only atomic review of one complete observation-gap reservation set. */
export class ObservationGapReviewModal extends Modal {
  /** Current process-local complete gap review; note bodies remain owned by the application service. */
  private detail: ReconciliationGapReviewDetail | null = null;
  /** Child action controls collected for one indivisible batch. */
  private readonly choices = new Map<MirrorOperationId, HTMLSelectElement>();
  /** Prevents overlapping candidate review creation. */
  private selecting = false;
  /** Prevents overlapping gap settlement or successor transfer. */
  private deciding = false;
  /** Prevents a late owner sample from publishing into a closed presentation lifetime. */
  private closed = false;
  /** Prevents reuse after one submission. */
  private submitted = false;

  /**
   * @param app - Obsidian modal host.
   * @param owner - Typed sanitized application facade.
   * @param sessionId - Current attached plugin enable identity.
   * @param candidates - Current unresolved gap predecessors and exact reservations.
   */
  constructor(
    app: App,
    private readonly owner: ReconciliationUiOwner,
    private readonly sessionId: string,
    private readonly candidates: readonly ReconciliationObservationGapCandidate[],
  ) {
    super(app);
  }

  /** Renders only operation identities, bounded paths, and owner-supplied actions. */
  override onOpen(): void {
    this.closed = false;
    this.titleEl.textContent = "AI Bridge observation-gap review";
    this.renderCandidates();
  }

  /** Invalidates an unsubmitted complete review and discards all transient controls. */
  override onClose(): void {
    this.closed = true;
    if (this.detail !== null && !this.submitted) {
      this.owner.closeObservationGapReview(
        this.sessionId,
        this.detail.reviewId,
      );
    }
    this.detail = null;
    this.choices.clear();
    this.contentEl.empty();
  }

  /** Lists every active predecessor without treating an empty list as proof of coverage. */
  private renderCandidates(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Unresolved observation gaps: ${this.candidates.length}`,
    });
    if (this.candidates.length === 0) {
      this.contentEl.createEl("p", {
        text: "No active observation-gap reservations are available.",
      });
      return;
    }
    for (const candidate of this.candidates) {
      const button = this.contentEl.createEl("button", {
        text: `${candidate.paths.join(", ")} (${candidate.operationId})`,
      });
      button.addEventListener("click", () => {
        void this.select(candidate);
      });
    }
  }

  /** Creates one complete fresh owner-side group sample for the selected predecessor. */
  private async select(
    candidate: ReconciliationObservationGapCandidate,
  ): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    this.disableButtons();
    const result = await this.owner.createObservationGapReview(
      this.sessionId,
      candidate.operationId,
    );
    if (this.closed) {
      if (result.kind === "created") {
        this.owner.closeObservationGapReview(
          this.sessionId,
          result.review.reviewId,
        );
      }
      return;
    }
    if (result.kind !== "created") {
      this.renderMessage(
        "A complete fresh review is unavailable. The predecessor remains reserved.",
      );
      return;
    }
    this.detail = result.review;
    this.renderReview(result.review);
  }

  /** Renders complete path coverage and all per-target choices before enabling one batch submit. */
  private renderReview(detail: ReconciliationGapReviewDetail): void {
    this.contentEl.empty();
    this.choices.clear();
    this.contentEl.createEl("p", {
      text: `Complete reservation set: ${detail.paths.join(", ")}`,
    });
    if (detail.unreviewablePaths.length > 0) {
      this.contentEl.createEl("p", {
        text: `Fresh evidence cannot safely transfer these paths: ${detail.unreviewablePaths.join(", ")}. No part of the predecessor can be released.`,
      });
      return;
    }
    if (detail.children.length === 0) {
      this.contentEl.createEl("p", {
        text: "Every reserved path is currently aligned; settlement still requires a fresh complete state-owner check.",
      });
      const settle = this.contentEl.createEl("button", {
        text: "Settle aligned gap without effects",
      });
      settle.addEventListener("click", () => {
        void this.submit([]);
      });
      return;
    }
    for (const child of detail.children) this.renderChild(child);
    const submit = this.contentEl.createEl("button", {
      text: "Transfer every changed path atomically",
    });
    submit.addEventListener("click", () => {
      void this.submit(this.selectedActions());
    });
  }

  /**
   * Renders one fresh target review and its supported ordinary action selector.
   * @param child - Fresh target-scoped review projection.
   * @returns Nothing; only owner-supplied actions become controls.
   */
  private renderChild(
    child: ReconciliationGapReviewDetail["children"][number],
  ): void {
    this.contentEl.createEl("h3", { text: child.targetPath });
    this.contentEl.createEl("p", {
      text: `Current classification: ${child.classification}`,
    });
    for (const side of ["local", "remote"] as const) {
      const preview = this.contentEl.createEl("button", {
        text: `Preview ${side} text for ${child.targetPath}`,
      });
      preview.addEventListener("click", () => {
        this.renderPreview(child.reviewId, side);
      });
    }
    if (child.allowedActions.length === 0) {
      this.contentEl.createEl("p", {
        text: "No ordinary action fits this path's retained reservation.",
      });
      return;
    }
    const choice = this.contentEl.createEl("select");
    if (child.allowedActions.includes(RECONCILIATION_ACTION.resolveHistory)) {
      choice.createEl("option", {
        text: "Retain history notes independently",
        value: HISTORY_DECISION_KIND.retainIndependent,
      });
      for (const candidate of child.historyCandidates) {
        choice.createEl("option", {
          text: `Execute cleanup toward ${candidate}`,
          value: `execute:${candidate}`,
        });
      }
      this.choices.set(child.reviewId, choice);
      return;
    }
    for (const action of child.allowedActions) {
      choice.createEl("option", { text: action, value: action });
    }
    choice.value = child.allowedActions[0] ?? "";
    this.choices.set(child.reviewId, choice);
  }

  /**
   * Collects every child decision; incomplete action sets are never submitted.
   * @returns Complete typed child actions or an empty sentinel when any control is invalid.
   */
  private selectedActions(): readonly ReconciliationGapActionSelection[] {
    if (this.detail === null) return [];
    const actions: ReconciliationGapActionSelection[] = [];
    for (const child of this.detail.children) {
      const choice = this.choices.get(child.reviewId);
      if (choice === undefined) return [];
      if (child.allowedActions.includes(RECONCILIATION_ACTION.resolveHistory)) {
        const selectedCandidate = child.historyCandidates.find(
          (candidate) => choice.value === `execute:${candidate}`,
        );
        if (choice.value === HISTORY_DECISION_KIND.retainIndependent) {
          actions.push({
            reviewId: child.reviewId,
            action: {
              kind: RECONCILIATION_ACTION.resolveHistory,
              decision: { kind: HISTORY_DECISION_KIND.retainIndependent },
            },
          });
          continue;
        }
        if (selectedCandidate === undefined) return [];
        actions.push({
          reviewId: child.reviewId,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: {
              kind: HISTORY_DECISION_KIND.executeCleanupPlan,
              selectedCandidatePath: selectedCandidate,
            },
          },
        });
        continue;
      }
      const selectedKind = child.allowedActions.find(
        (kind) => kind === choice.value,
      );
      if (selectedKind === undefined) return [];
      const action = createSimpleGapAction(selectedKind);
      if (action === null) return [];
      actions.push({ reviewId: child.reviewId, action });
    }
    return actions;
  }

  /**
   * Submits a complete group decision once and leaves refusal paths durably reserved.
   * @param actions - Every child action or an empty aligned no-effect decision.
   * @returns Nothing; fixed sanitized text communicates the outcome.
   */
  private async submit(
    actions: readonly ReconciliationGapActionSelection[],
  ): Promise<void> {
    if (this.submitted || this.deciding || this.detail === null) return;
    if (
      this.detail.unreviewablePaths.length > 0 ||
      (this.detail.children.length > 0 &&
        actions.length !== this.detail.children.length)
    ) {
      this.renderMessage(
        "Every changed path requires one supported fresh action.",
      );
      return;
    }
    this.deciding = true;
    this.disableButtons();
    const result = await this.owner.submitObservationGapReview(
      this.sessionId,
      this.detail.reviewId,
      actions,
    );
    this.submitted = result.kind === "completed" || result.kind === "admitted";
    if (!this.submitted) {
      this.owner.closeObservationGapReview(
        this.sessionId,
        this.detail.reviewId,
      );
    }
    this.renderMessage(gapResultMessage(result));
  }

  /** Displays a selected sampled body as inert literal text without interpreting Markdown. */
  private renderPreview(
    reviewId: MirrorOperationId,
    side: "local" | "remote",
  ): void {
    const preview = this.contentEl.createEl("pre");
    preview.textContent =
      this.owner.reconciliationPreview(this.sessionId, reviewId, side) ??
      `${side} preview is unavailable.`;
  }

  /** Disables controls while an owner-side sample or atomic commit is in progress. */
  private disableButtons(): void {
    for (const button of this.contentEl.querySelectorAll("button")) {
      button.disabled = true;
    }
  }

  /**
   * Replaces the modal body with one fixed sanitized outcome.
   * @param message - Fixed outcome text with no transport or note detail.
   * @returns Nothing; the prior sampled presentation is cleared.
   */
  private renderMessage(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: message });
  }
}

/**
 * Builds only actions that do not need a new destination or a separate history decision.
 * @param kind - Owner-supplied allowed action selected in the text-only modal.
 * @returns Typed simple action or null for a value outside the supported subset.
 */
function createSimpleGapAction(
  kind: ReconciliationAdmissionAction["kind"],
): ReconciliationAdmissionAction | null {
  switch (kind) {
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.restoreRecovery:
      return { kind };
    default:
      return null;
  }
}

/**
 * Maps owner outcomes to fixed text and never exposes transport or internal failure detail.
 * @param result - Sanitized command outcome.
 * @returns Fixed operator-facing status text.
 */
function gapResultMessage(result: ReconciliationUiCommandResult): string {
  if (result.kind === "completed") {
    return "The predecessor was safely settled without dispatching effects.";
  }
  if (result.kind === "admitted") {
    return "Every changed path was transferred to fresh reviewed successor operations.";
  }
  return "The review is stale or unavailable; all untransferred reservations remain held.";
}
