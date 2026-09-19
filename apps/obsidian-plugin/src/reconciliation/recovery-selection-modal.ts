import { RECONCILIATION_ACTION } from "@obsidian-ai-bridge/core";
import type {
  ReconciliationUiOwner,
  RecoverySelectionDetail,
} from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { type App, Modal } from "obsidian";

/** Text-only bounded recovery selector with explicit exact-path confirmation. */
export class RecoverySelectionModal extends Modal {
  /** Exact pending process-local review currently owned by this modal. */
  private reviewId:
    | import("@obsidian-ai-bridge/core").MirrorOperationId
    | null = null;
  /** Prevents overlapping recovery sampling within one presentation lifetime. */
  private selecting = false;
  /** Prevents duplicate restore admission after explicit confirmation. */
  private submitted = false;

  /**
   * @param app - Host UI owner.
   * @param owner - Typed application/runtime facade.
   * @param sessionId - Current attached plugin session.
   * @param recoveries - Bounded content-free recovery metadata.
   * @param incomplete - Whether inventory enumeration failed before proving completeness.
   */
  constructor(
    app: App,
    private readonly owner: ReconciliationUiOwner,
    private readonly sessionId: string,
    private recoveries: readonly RecoverySelectionDetail[],
    private readonly incomplete: boolean = false,
  ) {
    super(app);
  }

  /** Renders metadata rows without fetching or rendering recovery Markdown. */
  override onOpen(): void {
    this.titleEl.textContent = "AI Bridge recovery snapshot";
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Recoverable snapshots: ${this.recoveries.length}`,
    });
    if (this.incomplete) {
      this.contentEl.createEl("p", {
        text: "Recovery inventory is incomplete; every selection will be revalidated before admission.",
      });
    }
    for (const recovery of this.recoveries) {
      const button = this.contentEl.createEl("button", {
        text: `${recovery.path} — ${recovery.state}`,
      });
      button.addEventListener("click", () => {
        void this.select(recovery);
      });
    }
  }

  /** Clears metadata and invalidates an unsubmitted review. */
  override onClose(): void {
    if (this.reviewId !== null && !this.submitted) {
      this.owner.closeReconciliationReview(this.sessionId, this.reviewId);
    }
    this.reviewId = null;
    this.recoveries = [];
    this.contentEl.empty();
  }

  /** Creates an exact recovery-bound review, then requires a second confirmation click. */
  private async select(recovery: RecoverySelectionDetail): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    for (const control of this.contentEl.querySelectorAll("button")) {
      control.disabled = true;
    }
    const detail = await this.owner.createReconciliationReview(
      this.sessionId,
      recovery.path,
      recovery.id,
    );
    if (detail === null) {
      this.message("The recovery selection is unavailable or stale.");
      return;
    }
    this.reviewId = detail.reviewId;
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Restore untrusted plaintext to exact path: ${recovery.path}`,
    });
    this.contentEl.createEl("p", {
      text: "Existing content is never overwritten without exact reviewed evidence. The restored note will not be opened automatically.",
    });
    const pathConfirmation = this.contentEl.createEl("input");
    pathConfirmation.type = "text";
    pathConfirmation.placeholder = "Type the exact destination path";
    const confirm = this.contentEl.createEl("button", {
      text: "Confirm recovery restore",
    });
    confirm.addEventListener("click", () => {
      if (pathConfirmation.value !== recovery.path) {
        this.owner.closeReconciliationReview(this.sessionId, detail.reviewId);
        this.reviewId = null;
        this.message("The exact destination path was not confirmed.");
        return;
      }
      void this.submit(detail.reviewId);
    });
  }

  /**
   * Submits the typed restore decision at most once.
   * @param reviewId - Exact ephemeral review selected for recovery.
   */
  private async submit(
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
  ): Promise<void> {
    if (this.submitted) return;
    this.submitted = true;
    const result = await this.owner.submitReconciliation(
      this.sessionId,
      reviewId,
      { kind: RECONCILIATION_ACTION.restoreRecovery },
    );
    if (result.kind !== "admitted" && result.kind !== "completed") {
      this.owner.closeReconciliationReview(this.sessionId, reviewId);
    }
    this.message(
      result.kind === "admitted" || result.kind === "completed"
        ? "Recovery restore admitted."
        : "The recovery restore is stale or unavailable.",
    );
  }

  /**
   * Renders one fixed sanitized outcome.
   * @param text - Fixed application outcome message.
   */
  private message(text: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text });
  }
}
