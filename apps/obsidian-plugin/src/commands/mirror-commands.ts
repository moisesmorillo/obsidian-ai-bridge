import type { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import type { MirrorStatusUi } from "@obsidian-plugin/status/mirror-status-ui";
import type { Command, Plugin } from "obsidian";

/** Stable M3 operational command definitions; no per-note remote delete exists. */
export const MIRROR_OPERATIONAL_COMMANDS = {
  status: { id: "show-mirror-status", name: "Show mirror status" },
  check: { id: "check-mirror-now", name: "Check mirror now" },
  retry: { id: "retry-mirror-failures", name: "Retry mirror failures" },
  pause: { id: "pause-mirror", name: "Pause mirror" },
  resume: { id: "resume-mirror", name: "Resume mirror" },
  handoff: { id: "prepare-writer-handoff", name: "Prepare writer handoff" },
} as const satisfies Record<string, Pick<Command, "id" | "name">>;

/**
 * Thin command composition over typed runtime operations and text-only UI.
 * Delayed completions are ignored after this plugin session detaches.
 */
export class MirrorOperationalCommands {
  private attached = true;

  /**
   * @param plugin - Host command registration owner.
   * @param owner - Same-realm runtime operation owner.
   * @param ui - Session-owned text presentation.
   */
  constructor(
    private readonly plugin: Pick<Plugin, "addCommand">,
    private readonly owner: MirrorRuntimeOwner,
    private readonly ui: MirrorStatusUi,
  ) {}

  /** Registers only M3-wide operational commands. */
  register(): void {
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.status,
      callback: () => this.ui.showStatus(this.owner.status()),
    });
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.check,
      callback: () => this.run("check"),
    });
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.retry,
      callback: () => this.run("retry"),
    });
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.pause,
      callback: () => this.run("pause"),
    });
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.resume,
      callback: () => this.run("resume"),
    });
    this.plugin.addCommand({
      ...MIRROR_OPERATIONAL_COMMANDS.handoff,
      callback: () => {
        void this.owner.prepareHandoff().then((result) => {
          if (!this.attached) return;
          if (result.kind === "exported") {
            this.ui.showHandoffExport(result.encoded);
            return;
          }
          this.ui.showMessage(
            "Handoff is not ready. Resolve pending or blocked work first.",
          );
        });
      },
    });
  }

  /** Invalidates pending presentation callbacks at unload. */
  detach(): void {
    this.attached = false;
  }

  /**
   * Runs one closed operational action and presents only a sanitized result.
   * @param operation - Stable operation selected by a registered command.
   */
  private async run(operation: "check" | "retry" | "pause" | "resume") {
    const result = await this.execute(operation);
    if (!this.attached) return;
    this.ui.showMessage(
      result.kind === "completed"
        ? "Mirror operation completed."
        : "Mirror operation is not ready or could not complete.",
    );
  }

  /**
   * @param operation - Stable operation selected by a registered command.
   * @returns The typed runtime operation selected by the key.
   */
  private execute(operation: "check" | "retry" | "pause" | "resume") {
    switch (operation) {
      case "check":
        return this.owner.checkNow();
      case "retry":
        return this.owner.retryFailures();
      case "pause":
        return this.owner.pause();
      case "resume":
        return this.owner.resume();
    }
  }
}
