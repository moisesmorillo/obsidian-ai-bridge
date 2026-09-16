import {
  LocalInspectionService,
  type LocalInspector,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import { createObsidianVaultHost } from "@obsidian-plugin/infrastructure/obsidian-vault-host";
import { InspectionCommand } from "@obsidian-plugin/inspection/inspection.constants";
import type { InspectionSession } from "@obsidian-plugin/inspection/inspection-session.types";
import { LocalInspectionUi } from "@obsidian-plugin/inspection/local-inspection-ui";
import { MirrorPluginSession } from "@obsidian-plugin/runtime/mirror-plugin-session";
import { Notice, Plugin } from "obsidian";

/** Thin Obsidian composition entrypoint for M2 inspection and M3 runtime attachment. */
export default class AiBridgePlugin extends Plugin {
  private inspectionSession: InspectionSession | undefined;
  private mirrorSession: MirrorPluginSession | null = null;
  private enableGeneration = 0;
  /** Excludes overlapping M2 inspection work across enable lifetimes. */
  private inspectionInFlight = false;

  /** Registers M2 commands, then composes strict M3 state/configuration ownership. */
  override async onload(): Promise<void> {
    const generation = ++this.enableGeneration;
    this.registerInspectionCommands();
    const mirrorSession = await MirrorPluginSession.create(
      this,
      () => this.enableGeneration === generation,
    );
    if (this.enableGeneration !== generation) {
      mirrorSession?.detach();
      return;
    }
    this.mirrorSession = mirrorSession;
    if (mirrorSession === null) {
      this.addCommand({
        id: "show-mirror-status",
        name: "Show mirror status",
        callback: () =>
          new Notice(
            "AI Bridge mirror runtime is unavailable. Local inspection remains available.",
          ),
      });
    }
  }

  /** Invalidates presentation/listeners/timers without discarding runtime settlement. */
  override onunload(): void {
    this.enableGeneration += 1;
    const inspection = this.inspectionSession;
    this.inspectionSession = undefined;
    inspection?.ui.close();
    this.mirrorSession?.detach();
    this.mirrorSession = null;
  }

  /** Applies externally changed data.json through the same fail-closed owner path. */
  override onExternalSettingsChange(): void {
    const session = this.mirrorSession;
    if (session === null) return;
    void session.reloadExternalConfiguration().catch(() => undefined);
  }

  private registerInspectionCommands(): void {
    const vault = new ObsidianLocalVault(
      createObsidianVaultHost(this.app.vault),
    );
    this.inspectionSession = {
      inspector: new LocalInspectionService(vault, vault.policy),
      ui: new LocalInspectionUi(this.app),
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

  /**
   * Serializes M2 plugin-instance work while suppressing stale UI after unload.
   *
   * @param operation - One local inspection service invocation.
   * @param present - Metadata-only UI result dispatch.
   */
  private async inspect<Result>(
    operation: (inspector: LocalInspector) => Promise<Result>,
    present: (ui: LocalInspectionUi, result: Result) => void,
  ): Promise<void> {
    const session = this.inspectionSession;
    if (session === undefined) return;
    if (this.inspectionInFlight) {
      session.ui.showBusy();
      return;
    }
    this.inspectionInFlight = true;
    try {
      const result = await operation(session.inspector);
      if (this.inspectionSession === session) present(session.ui, result);
    } catch {
      if (this.inspectionSession === session) session.ui.showUnavailable();
    } finally {
      this.inspectionInFlight = false;
    }
  }
}
