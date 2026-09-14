import {
  type LocalInspectionKind,
  type LocalListResult,
  LocalSkipReason,
} from "@obsidian-ai-bridge/core";
import { type App, Modal } from "obsidian";

/** Displays only deliberate local metadata using text sinks; never parses Markdown or HTML. */
export class LocalNotesModal extends Modal {
  /**
   * @param app - Host UI owner; no vault operations are performed here.
   * @param result - Metadata-only successful enumeration, retained only while open.
   */
  constructor(
    app: App,
    private result: Extract<
      LocalListResult,
      { kind: typeof LocalInspectionKind.ok }
    > | null,
  ) {
    super(app);
  }

  /** Renders exact names and byte counts without making paths into links or markup. */
  override onOpen(): void {
    const result = this.result;
    if (result === null) return;
    this.titleEl.textContent = "Local Markdown inspection";
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Eligible notes: ${result.entries.length}`,
    });
    if (result.entries.length === 0) {
      this.contentEl.createEl("p", {
        text: "No eligible local Markdown notes.",
      });
    }
    for (const entry of result.entries) {
      this.contentEl.createEl("p", {
        text: `${entry.path} — ${entry.sizeBytes} bytes`,
      });
    }
    this.contentEl.createEl("p", {
      text: `Skipped files: ${Object.values(result.skipped).reduce((sum, count) => sum + count, 0)}`,
    });
    this.contentEl.createEl("p", {
      text: `Unsupported files: ${result.skipped[LocalSkipReason.unsupportedFile]}`,
    });
    this.contentEl.createEl("p", {
      text: `Excluded locations: ${result.skipped[LocalSkipReason.excludedLocation]}`,
    });
    this.contentEl.createEl("p", {
      text: `Invalid paths: ${result.skipped[LocalSkipReason.invalidPath]}`,
    });
    this.contentEl.createEl("p", {
      text: `Oversized files: ${result.skipped[LocalSkipReason.oversized]}`,
    });
  }

  /** Releases metadata on user dismissal as well as plugin unload/replacement. */
  override onClose(): void {
    this.contentEl.empty();
    this.result = null;
  }
}
