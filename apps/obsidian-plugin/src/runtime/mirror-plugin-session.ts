import { MirrorOperationalCommands } from "@obsidian-plugin/commands/mirror-commands";
import { ReconciliationCommands } from "@obsidian-plugin/commands/reconciliation-commands";
import { MirrorConfigurationController } from "@obsidian-plugin/configuration/mirror-configuration-controller";
import { ObsidianPluginDataStore } from "@obsidian-plugin/configuration/mirror-preferences";
import { MirrorSettingsTab } from "@obsidian-plugin/configuration/mirror-settings-tab";
import { ObsidianMirrorEvents } from "@obsidian-plugin/events/obsidian-mirror-events";
import { createMirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-factory";
import type { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import {
  BrowserMirrorTimerHost,
  MirrorWakeScheduler,
} from "@obsidian-plugin/runtime/mirror-wake-scheduler";
import { acquireRuntimeMirrorCoordinator } from "@obsidian-plugin/state/runtime-mirror-coordinator";
import { MirrorStatusUi } from "@obsidian-plugin/status/mirror-status-ui";
import type { Plugin } from "obsidian";

/**
 * One plugin-instance presentation/event/timer attachment to a same-realm owner.
 * Runtime work and durable settlement remain in `MirrorRuntimeOwner` after detach.
 */
export class MirrorPluginSession {
  private attached = true;

  /** Retains one enable-lifetime set of presentation/listener/timer resources after same-realm owner acquisition. */
  private constructor(
    private readonly id: string,
    private readonly owner: MirrorRuntimeOwner,
    private readonly configuration: MirrorConfigurationController,
    private readonly events: ObsidianMirrorEvents,
    private readonly wake: MirrorWakeScheduler,
    private readonly commands: MirrorOperationalCommands,
    private readonly reconciliationCommands: ReconciliationCommands,
    private readonly settings: MirrorSettingsTab,
    private readonly ui: MirrorStatusUi,
    private readonly statusBar: HTMLElement | null,
  ) {}

  /**
   * Loads strict configuration/state, acquires ownership, builds the event adapter,
   * then registers UI and the layout-ready callback that attaches listeners.
   *
   * @param plugin - Current official Plugin instance.
   * @param isCurrent - Enable-generation guard checked after every asynchronous boundary.
   * @returns Attached session or `null` when ownership/state is incompatible.
   */
  static async create(
    plugin: Plugin,
    isCurrent: () => boolean = () => true,
  ): Promise<MirrorPluginSession | null> {
    const dataStore = new ObsidianPluginDataStore(plugin);
    const decodedPreferences = await dataStore.load();
    if (!isCurrent()) return null;
    const acquired = await acquireRuntimeMirrorCoordinator(plugin.app, () =>
      createMirrorRuntimeOwner(plugin.app, plugin.app.vault),
    );
    if (acquired.kind !== "acquired" || !isCurrent()) return null;
    if (
      globalThis.crypto === undefined ||
      typeof globalThis.crypto.randomUUID !== "function"
    ) {
      return null;
    }

    const id = globalThis.crypto.randomUUID();
    let session: MirrorPluginSession | null = null;
    const attached = acquired.coordinator.attach({
      id,
      onChanged: () => session?.refresh(),
    });
    if (attached.kind !== "attached") return null;

    const configuration = new MirrorConfigurationController(
      dataStore,
      acquired.coordinator,
    );
    await configuration.initialize(decodedPreferences);
    if (!isCurrent()) {
      configuration.detach();
      acquired.coordinator.detach(id);
      return null;
    }

    const events = new ObsidianMirrorEvents(
      plugin.app.vault,
      plugin,
      acquired.coordinator,
      { configDirectory: plugin.app.vault.configDir },
    );
    const ui = new MirrorStatusUi(plugin.app);
    const commands = new MirrorOperationalCommands(
      plugin,
      acquired.coordinator,
      ui,
    );
    commands.register();
    const reconciliationCommands = new ReconciliationCommands(
      plugin,
      acquired.coordinator,
      id,
    );
    reconciliationCommands.register();
    const settings = new MirrorSettingsTab(
      plugin.app,
      plugin,
      configuration,
      acquired.coordinator,
      ui,
    );
    plugin.addSettingTab(settings);
    const statusBar = createStatusBar(plugin);
    const wake = new MirrorWakeScheduler(
      acquired.coordinator,
      new BrowserMirrorTimerHost(),
      () => session?.refresh(),
    );
    session = new MirrorPluginSession(
      id,
      acquired.coordinator,
      configuration,
      events,
      wake,
      commands,
      reconciliationCommands,
      settings,
      ui,
      statusBar,
    );
    session.refresh();

    plugin.app.workspace.onLayoutReady(() => {
      if (!session?.isCurrent() || !events.attach()) return;
      void acquired.coordinator
        .onLayoutReady(
          id,
          () => events.drainQueued(),
          () => events.activate(),
        )
        .catch(() => undefined);
    });
    return session;
  }

  /** Reloads externally changed data.json without restoring stale active state. */
  async reloadExternalConfiguration(): Promise<void> {
    if (!this.isCurrent()) return;
    await this.configuration.reloadExternal();
  }

  /**
   * Detaches listener/UI/timer ownership and closes new request admission.
   * In-flight owner work keeps its reservations and exact settlement path.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.owner.detach(this.id);
    this.events.detach();
    this.wake.detach();
    this.commands.detach();
    this.reconciliationCommands.detach();
    this.settings.detach();
    this.configuration.detach();
    this.ui.close();
    if (this.statusBar !== null) this.statusBar.textContent = "";
  }

  /**
   * Requires both local attachment and owner presentation identity before delivering UI or timer work.
   *
   * @returns Whether this attachment remains the owner's current presentation.
   */
  private isCurrent(): boolean {
    return this.attached && this.owner.isAttached(this.id);
  }

  /** Refreshes sanitized UI and one-shot scheduling only for the current session; does not restart owner state. */
  private refresh(): void {
    if (!this.isCurrent()) return;
    this.wake.reconcile();
    this.settings.update();
    if (this.statusBar !== null) {
      const status = this.owner.status();
      this.statusBar.textContent = `AI Bridge: ${status.writer}; ${status.pendingPaths} pending`;
    }
  }
}

/** @returns A best-effort host status item, or null when the host omits it. */
function createStatusBar(plugin: Plugin): HTMLElement | null {
  try {
    const element = plugin.addStatusBarItem();
    element.textContent = "AI Bridge: inactive";
    return element;
  } catch {
    return null;
  }
}
