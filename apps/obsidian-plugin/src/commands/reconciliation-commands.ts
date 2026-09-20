import { ReconciliationReviewModal } from "@obsidian-plugin/reconciliation/reconciliation-review-modal";
import type { ReconciliationUiOwner } from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { RecoverySelectionModal } from "@obsidian-plugin/reconciliation/recovery-selection-modal";
import type { Command, Plugin } from "obsidian";

/** Stable M4 review command definitions. */
export const RECONCILIATION_COMMANDS = {
  review: {
    id: "review-remote-divergence",
    name: "Review remote divergence",
  },
  restore: {
    id: "restore-recovery-snapshot",
    name: "Restore recovery snapshot",
  },
} as const satisfies Record<string, Pick<Command, "id" | "name">>;

/** Thin command adapter opening text-only views over sanitized runtime projections. */
export class ReconciliationCommands {
  /** Presentation-lifetime fence preventing delayed modal publication after detach. */
  private attached = true;

  /**
   * @param plugin - Current command/modal host.
   * @param owner - Same-realm application owner.
   * @param sessionId - Current attached plugin session identity.
   */
  constructor(
    private readonly plugin: Pick<Plugin, "addCommand" | "app">,
    private readonly owner: ReconciliationUiOwner,
    private readonly sessionId: string,
  ) {}

  /** Registers M4 commands without performing reads or mutations at registration time. */
  register(): void {
    this.plugin.addCommand({
      ...RECONCILIATION_COMMANDS.review,
      callback: () => {
        void this.openReview();
      },
    });
    this.plugin.addCommand({
      ...RECONCILIATION_COMMANDS.restore,
      callback: () => {
        void this.openRecovery();
      },
    });
  }

  /** Prevents delayed command completions from opening stale UI. */
  detach(): void {
    this.attached = false;
  }

  /** Opens the candidate modal only after a current sanitized query completes. */
  private async openReview(): Promise<void> {
    const result = await this.owner.listReconciliationCandidates(
      this.sessionId,
    );
    if (!this.attached || result.kind === "unavailable") return;
    new ReconciliationReviewModal(
      this.plugin.app,
      this.owner,
      this.sessionId,
      result.candidates,
      result.kind === "incomplete",
    ).open();
  }

  /** Opens bounded recovery metadata without fetching recovery content. */
  private async openRecovery(): Promise<void> {
    const result = await this.owner.listRecoverySelections(this.sessionId);
    if (!this.attached || result.kind === "unavailable") return;
    new RecoverySelectionModal(
      this.plugin.app,
      this.owner,
      this.sessionId,
      result.recoveries,
      result.kind === "incomplete",
    ).open();
  }
}
