import {
  type LocalActiveInspectionResult,
  LocalInspectionKind,
  type LocalListResult,
  LocalVaultFailureReason,
} from "@obsidian-ai-bridge/core";
import {
  INSPECTION_BUSY_MESSAGE,
  InspectionFailureMessage,
  SAVED_FILE_GUIDANCE,
} from "@obsidian-plugin/inspection/inspection.constants";
import { LocalNotesModal } from "@obsidian-plugin/inspection/local-notes-modal";
import { type App, Notice } from "obsidian";

/** Owns ephemeral metadata UI only; it never receives note bodies or accesses the vault. */
export class LocalInspectionUi {
  private modal: LocalNotesModal | undefined;
  private notice: Notice | undefined;

  /** @param app - Official owner used only to construct a host modal. */
  constructor(private readonly app: App) {}

  /**
   * @param result - Sorted eligible metadata, or a sanitized enumeration failure.
   */
  showList(result: LocalListResult): void {
    if (result.kind === LocalInspectionKind.failed) {
      this.showUnavailable();
      return;
    }
    this.modal?.close();
    this.modal = new LocalNotesModal(this.app, result);
    this.modal.open();
  }

  /**
   * @param result - Metadata only; the application already discarded saved note text.
   */
  showActive(result: LocalActiveInspectionResult): void {
    if (result.kind === LocalInspectionKind.failed) {
      this.showNotice(InspectionFailureMessage[result.reason]);
      return;
    }
    this.showNotice(
      `Saved note: ${result.entry.path}\nUTF-8 bytes: ${result.entry.sizeBytes}\n${SAVED_FILE_GUIDANCE}`,
    );
  }

  /** Reports overlap without starting or queuing another operation. */
  showBusy(): void {
    this.showNotice(INSPECTION_BUSY_MESSAGE);
  }

  /** Unexpected failures use the same sanitized unavailable message as typed failures. */
  showUnavailable(): void {
    this.showNotice(
      InspectionFailureMessage[LocalVaultFailureReason.unavailable],
    );
  }

  /** Hides active UI and releases references; no host read cancellation is implied. */
  close(): void {
    this.modal?.close();
    this.notice?.hide();
    this.modal = undefined;
    this.notice = undefined;
  }

  /**
   * @param message - Plain text, never a Markdown/HTML fragment or raw exception.
   */
  private showNotice(message: string): void {
    this.notice?.hide();
    this.notice = new Notice(message);
  }
}
