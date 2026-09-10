import {
  LocalInspectionService,
  type LocalInspector,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import { createObsidianVaultHost } from "@obsidian-plugin/infrastructure/obsidian-vault-host";
import { InspectionCommand } from "@obsidian-plugin/inspection/inspection.constants";
import type { InspectionSession } from "@obsidian-plugin/inspection/inspection-session.types";
import { LocalInspectionUi } from "@obsidian-plugin/inspection/local-inspection-ui";
import { Plugin } from "obsidian";

/** Local-only composition and command lifecycle; enabling performs no inspection or persistence. */
export default class AiBridgePlugin extends Plugin {
  private session: InspectionSession | undefined;

  /** Composes read-only capabilities and registers exactly two host-owned palette commands. */
  override onload(): void {
    const vault = new ObsidianLocalVault(
      createObsidianVaultHost(this.app.vault),
    );
    this.session = {
      inspector: new LocalInspectionService(vault, vault.policy),
      ui: new LocalInspectionUi(this.app),
      busy: false,
    };
    this.addCommand({
      ...InspectionCommand.list,
      callback: () =>
        this.inspect(
          (inspector) => inspector.list(),
          (ui, result) => ui.showList(result),
        ),
    });
    this.addCommand({
      ...InspectionCommand.active,
      callback: () =>
        this.inspect(
          (inspector) =>
            inspector.inspectActivePath(
              this.app.workspace.getActiveFile()?.path ?? null,
            ),
          (ui, result) => ui.showActive(result),
        ),
    });
  }

  /** Invalidates in-flight UI and releases owned state; the host disposes addCommand registrations. */
  override onunload(): void {
    const session = this.session;
    this.session = undefined;
    session?.ui.close();
  }

  /**
   * Serializes both commands and suppresses results from an unloaded enable lifetime.
   * The operation runs synchronously up to its first await, capturing active identity
   * at invocation rather than looking up the active pane after the saved-file read.
   *
   * @param operation - One service invocation, with host active-path capture if needed.
   * @param present - Metadata-only UI result dispatch, never called after unload.
   */
  private async inspect<Result>(
    operation: (inspector: LocalInspector) => Promise<Result>,
    present: (ui: LocalInspectionUi, result: Result) => void,
  ): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    if (session.busy) {
      session.ui.showBusy();
      return;
    }
    session.busy = true;
    try {
      const result = await operation(session.inspector);
      if (this.session === session) present(session.ui, result);
    } catch {
      if (this.session === session) session.ui.showUnavailable();
    } finally {
      session.busy = false;
    }
  }
}
