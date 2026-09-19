import {
  HISTORY_DECISION_KIND,
  type NotePath,
  RECONCILIATION_ACTION,
  RECONCILIATION_PRESERVATION_SIDE,
  type ReconciliationAction,
} from "@obsidian-ai-bridge/core";
import type {
  ReconciliationReviewDetail,
  ReconciliationUiOwner,
} from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { type App, Modal } from "obsidian";

/** Text-only reviewed divergence modal; it contains no policy, transport, or Vault capability. */
export class ReconciliationReviewModal extends Modal {
  /** Exact pending process-local review currently rendered by this modal. */
  private detail: ReconciliationReviewDetail | null = null;
  /** Prevents overlapping candidate sampling within one presentation lifetime. */
  private selecting = false;
  /** Prevents overlapping destination sampling or decision submission. */
  private deciding = false;
  /** Prevents duplicate decision admission after one operator submission. */
  private submitted = false;

  /**
   * @param app - Host UI owner.
   * @param owner - Typed application/runtime facade.
   * @param sessionId - Current attached plugin session.
   * @param candidates - Bounded sanitized candidate paths.
   * @param incomplete - Whether inventory enumeration failed before proving completeness.
   */
  constructor(
    app: App,
    private readonly owner: ReconciliationUiOwner,
    private readonly sessionId: string,
    private candidates: readonly NotePath[],
    private readonly incomplete: boolean = false,
  ) {
    super(app);
  }

  /** Renders candidate metadata using text sinks only. */
  override onOpen(): void {
    this.titleEl.textContent = "AI Bridge remote divergence review";
    this.renderCandidates();
  }

  /** Clears every DOM text node and invalidates any unsubmitted ephemeral review. */
  override onClose(): void {
    if (this.detail !== null && !this.submitted) {
      this.owner.closeReconciliationReview(
        this.sessionId,
        this.detail.reviewId,
      );
    }
    this.detail = null;
    this.candidates = [];
    this.contentEl.empty();
  }

  /** Renders the bounded candidate list without links or automatic reads. */
  private renderCandidates(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Review candidates: ${this.candidates.length}`,
    });
    if (this.incomplete) {
      this.contentEl.createEl("p", {
        text: "Candidate inventory is incomplete; every selection will be resampled before admission.",
      });
    }
    if (this.candidates.length === 0) {
      this.contentEl.createEl("p", {
        text: "No review candidates are available.",
      });
      return;
    }
    for (const path of this.candidates) {
      const button = this.contentEl.createEl("button", { text: path });
      button.addEventListener("click", () => {
        void this.select(path);
      });
    }
  }

  /** Samples the selected path through the application owner and renders supplied actions. */
  private async select(path: NotePath): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    for (const control of this.contentEl.querySelectorAll("button")) {
      control.disabled = true;
    }
    const detail = await this.owner.createReconciliationReview(
      this.sessionId,
      path,
    );
    if (detail === null) {
      this.renderMessage("The review is unavailable or stale.");
      return;
    }
    this.detail = detail;
    this.renderDetail(detail);
  }

  /** Renders supplied classification/actions and explicit inert preview controls. */
  private renderDetail(detail: ReconciliationReviewDetail): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `Path: ${detail.targetPath}` });
    this.contentEl.createEl("p", {
      text: `Classification: ${detail.classification}`,
    });
    for (const side of ["local", "remote"] as const) {
      const preview = this.contentEl.createEl("button", {
        text: `Show ${side} text preview`,
      });
      preview.addEventListener("click", () => this.renderPreview(side));
    }
    for (const actionKind of detail.allowedActions) {
      this.renderActionControls(detail, actionKind);
    }
  }

  /** Renders exact action controls without deriving whether an action is allowed. */
  private renderActionControls(
    detail: ReconciliationReviewDetail,
    actionKind: ReconciliationAction["kind"],
  ): void {
    if (actionKind === RECONCILIATION_ACTION.keepBoth) {
      this.renderDestinationActionButton("Keep both (local primary)", {
        kind: actionKind,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
      });
      this.renderDestinationActionButton("Keep both (remote primary)", {
        kind: actionKind,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
      });
      return;
    }
    if (actionKind === RECONCILIATION_ACTION.forkLegacy) {
      this.renderDestinationActionButton("Fork legacy note", {
        kind: actionKind,
      });
      return;
    }
    if (actionKind === RECONCILIATION_ACTION.resolveHistory) {
      this.renderActionButton("Retain history notes independently", {
        kind: actionKind,
        decision: { kind: HISTORY_DECISION_KIND.retainIndependent },
      });
      this.renderActionButton("Defer history decision", {
        kind: actionKind,
        decision: { kind: HISTORY_DECISION_KIND.deferHistory },
      });
      this.renderActionButton("Execute cleanup toward selected path", {
        kind: actionKind,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          canonicalPath: detail.targetPath,
        },
      });
      return;
    }
    this.renderActionButton(actionKind, { kind: actionKind });
  }

  /**
   * Renders an explicit destination control and resamples it before admission.
   * @param label - Literal button label.
   * @param action - Typed decision requiring a distinct destination.
   */
  private renderDestinationActionButton(
    label: string,
    action: ReconciliationAction,
  ): void {
    const destination = this.contentEl.createEl("input");
    destination.type = "text";
    destination.placeholder = "Destination Markdown path";
    const button = this.contentEl.createEl("button", { text: label });
    button.addEventListener("click", () => {
      void this.submitWithDestination(action, destination.value);
    });
  }

  /**
   * Samples an explicit destination under a fresh review before submitting the decision.
   * @param action - Typed destination-bearing decision.
   * @param candidate - Untrusted literal path entered by the operator.
   */
  private async submitWithDestination(
    action: ReconciliationAction,
    candidate: string,
  ): Promise<void> {
    if (this.submitted || this.deciding || this.detail === null) return;
    this.deciding = true;
    for (const control of this.contentEl.querySelectorAll("button")) {
      control.disabled = true;
    }
    const detail = await this.owner.createReconciliationReview(
      this.sessionId,
      this.detail.targetPath,
      null,
      candidate,
    );
    if (detail === null) {
      this.renderMessage("The destination evidence is stale or unavailable.");
      return;
    }
    if (!detail.allowedActions.includes(action.kind)) {
      this.owner.closeReconciliationReview(this.sessionId, detail.reviewId);
      this.renderMessage("The destination evidence is stale or unavailable.");
      return;
    }
    if (detail.destinationPath === null) {
      this.owner.closeReconciliationReview(this.sessionId, detail.reviewId);
      this.renderMessage("The destination evidence is stale or unavailable.");
      return;
    }
    this.detail = detail;
    await this.submitDecision(detail, action, detail.destinationPath);
  }

  /**
   * Renders one operator decision button and disables later submissions.
   * @param label - Literal button label.
   * @param action - Typed decision submitted without UI policy derivation.
   */
  private renderActionButton(
    label: string,
    action: ReconciliationAction,
  ): void {
    const button = this.contentEl.createEl("button", { text: label });
    button.addEventListener("click", () => {
      if (this.submitted || this.deciding || this.detail === null) return;
      this.deciding = true;
      void this.submitDecision(this.detail, action);
    });
  }

  /**
   * Disables duplicate controls and submits one exact reviewed decision.
   * @param detail - Exact ephemeral review being admitted.
   * @param action - Typed operator decision.
   * @param destinationPath - Optional destination included in the sampled review.
   */
  private async submitDecision(
    detail: ReconciliationReviewDetail,
    action: ReconciliationAction,
    destinationPath?: NotePath,
  ): Promise<void> {
    this.submitted = true;
    for (const control of this.contentEl.querySelectorAll("button")) {
      control.disabled = true;
    }
    const result = await this.owner.submitReconciliation(
      this.sessionId,
      detail.reviewId,
      action,
      destinationPath,
    );
    if (result.kind !== "admitted" && result.kind !== "completed") {
      this.owner.closeReconciliationReview(this.sessionId, detail.reviewId);
    }
    this.renderMessage(
      result.kind === "admitted" || result.kind === "completed"
        ? "Reconciliation decision admitted."
        : "The reconciliation decision is stale or unavailable.",
    );
  }

  /**
   * Displays sampled note text literally in a preformatted text node.
   * @param side - Explicitly requested sampled side.
   */
  private renderPreview(side: "local" | "remote"): void {
    if (this.detail === null) return;
    const text = this.owner.reconciliationPreview(
      this.sessionId,
      this.detail.reviewId,
      side,
    );
    const preview = this.contentEl.createEl("pre");
    preview.textContent = text ?? `${side} preview is unavailable.`;
  }

  /**
   * Replaces the modal body with one fixed sanitized result.
   * @param message - Fixed application outcome message.
   */
  private renderMessage(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: message });
  }
}
