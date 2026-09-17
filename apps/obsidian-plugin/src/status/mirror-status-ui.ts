import type { MirrorOperationalStatus } from "@obsidian-plugin/status/mirror-status";
import { formatMirrorOperationalStatus } from "@obsidian-plugin/status/mirror-status";
import { type App, Modal, Notice } from "obsidian";

/** Text-only operational UI owned by one plugin enable lifetime. */
export class MirrorStatusUi {
  private modal: MirrorTextModal | null = null;
  private notice: Notice | null = null;

  /** @param app - Official host UI context. */
  constructor(private readonly app: App) {}

  /**
   * Shows sanitized current runtime status without raw failures or response data.
   * @param status - Closed operational status projection.
   */
  showStatus(status: MirrorOperationalStatus): void {
    this.showModal(
      "AI Bridge mirror status",
      formatMirrorOperationalStatus(status),
    );
  }

  /**
   * Shows one fixed/sanitized operational message.
   * @param message - Product-owned text without raw exception/transport details.
   */
  showMessage(message: string): void {
    this.notice?.hide();
    this.notice = new Notice(message);
  }

  /**
   * Shows explicit metadata-only handoff transfer text for user-controlled copy.
   * @param encoded - Checksum-covered handoff JSON containing no note body or secret.
   */
  showHandoffExport(encoded: string): void {
    this.showModal("AI Bridge writer handoff", encoded);
  }

  /** Closes and clears all session-owned presentation on unload. */
  close(): void {
    this.notice?.hide();
    this.notice = null;
    this.modal?.close();
    this.modal = null;
  }

  /**
   * Replaces the session's prior modal with text-only status or explicit handoff metadata and releases its reference on close.
   *
   * @param title - Fixed presentation title.
   * @param text - Text-only status or explicitly requested handoff metadata.
   */
  private showModal(title: string, text: string): void {
    this.modal?.close();
    this.modal = new MirrorTextModal(this.app, title, text, () => {
      this.modal = null;
    });
    this.modal.open();
  }
}

/** Plain-text modal that never invokes HTML parsing APIs. */
class MirrorTextModal extends Modal {
  /**
   * @param app - Official host UI context.
   * @param title - Fixed trusted title.
   * @param text - Text-only sanitized status or explicit handoff JSON.
   * @param onClosed - Session cleanup callback.
   */
  constructor(
    app: App,
    private readonly title: string,
    private readonly text: string,
    private readonly onClosed: () => void,
  ) {
    super(app);
  }

  /** Renders only textContent-backed elements. */
  override onOpen(): void {
    this.titleEl.textContent = this.title;
    this.contentEl.empty();
    this.contentEl.createEl("pre", { text: this.text });
  }

  /** Releases potentially sensitive path/hash metadata on close. */
  override onClose(): void {
    this.contentEl.empty();
    this.titleEl.empty();
    this.onClosed();
  }
}
