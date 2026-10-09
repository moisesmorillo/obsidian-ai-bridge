import type { SyncDemoClientOutcome } from "@obsidian-ai-bridge/core";
import { SYNC_REMOTE_MODE } from "@obsidian-ai-bridge/protocol";
import {
  DEMO_PRESENTATION,
  type DemoPresentation,
  type DemoProfile,
  decodeDemoConfig,
  LOCAL_DEMO_PROFILE,
  readDemoString,
} from "@obsidian-plugin/demo/demo-config";
import {
  acquireDemoOwner,
  type DemoOwner,
} from "@obsidian-plugin/demo/demo-owner";
import { DemoSettings } from "@obsidian-plugin/demo/demo-settings";
import { Plugin } from "obsidian";

/** Separate experimental artifact entrypoint; no release/M3 module is imported or activated. */
export default class DemoPlugin extends Plugin {
  /** Artifact-selected authority; the local entrypoint never selects a remote profile through settings. */
  protected readonly profile: DemoProfile = LOCAL_DEMO_PROFILE;
  private owner: DemoOwner | null = null;
  private lease = 0;
  private alive = false;
  private message: DemoPresentation = DEMO_PRESENTATION.notArmed;
  private bar: HTMLElement | null = null;
  private reference = "demo-native-secret";
  /** Registers explicit commands/settings and listeners before arming; there is no automatic network pass. */
  override onload(): void {
    this.alive = true;
    this.reference = this.profile.secretReference;
    this.bar = this.addStatusBarItem();
    /** All saved events retain successor observation, never authorizing removal or suppressing own effects. */
    const observed = () => {
      this.owner?.observed(this.lease);
    };
    this.registerEvent(this.app.vault.on("create", observed));
    this.registerEvent(this.app.vault.on("modify", observed));
    this.registerEvent(this.app.vault.on("delete", observed));
    this.registerEvent(this.app.vault.on("rename", observed));
    this.addCommand({
      id: "sync-now",
      name: "Synthetic demo: Sync now",
      callback: () => {
        void this.syncNow();
      },
    });
    this.addSettingTab(new DemoSettings(this));
    this.connect();
    this.present(this.message);
  }
  /** Invalidates future effects/UI without discarding the retained owner's in-flight settlement or local ledger. */
  override onunload(): void {
    this.alive = false;
    this.owner?.detach(this.lease);
    this.bar = null;
  }
  /** Returns only non-secret host-local config text or a deliberately unarmed template, never existing Vault contents.
   * @returns Exact local string or an unarmed configuration draft; unreadable input becomes no draft.
   */
  configurationText(): string {
    try {
      const stored = readDemoString(this.app, this.profile.configKey);
      if (stored !== null) return stored;
    } catch {
      return "";
    }
    return JSON.stringify(
      {
        mode: this.profile.mode,
        endpoint: this.profile.endpoint,
        ...(this.profile.mode === SYNC_REMOTE_MODE ? { experimentId: "" } : {}),
        vaultId: "",
        deviceId: crypto.randomUUID(),
        paths: ["demo.md"],
        secretReference: this.reference,
        acknowledgement: "",
      },
      null,
      2,
    );
  }
  /** Shows a closed, content-free operational category; remote/user content is never interpreted as markup.
   * @returns Current trusted presentation category.
   */
  statusText(): string {
    return this.message;
  }
  /** Returns a non-secret native selector value; it is never an authorization token.
   * @returns Native entry reference only, never secret contents.
   */
  secretReference(): string {
    return this.reference;
  }
  /** Saves only a validated arming/binding with exact read-back; a retained different configuration cannot redirect work.
   * @param text Untrusted non-secret settings JSON, with explicit disposable acknowledgement.
   */
  configure(text: string): void {
    const config = decodeDemoConfig(text, this.profile);
    if (
      config === null ||
      this.owner?.isBusy() ||
      (this.owner !== null && this.owner.key !== JSON.stringify(config))
    ) {
      this.present("attention");
      return;
    }
    try {
      const serialized = JSON.stringify(config);
      this.app.saveLocalStorage(this.profile.configKey, serialized);
      if (readDemoString(this.app, this.profile.configKey) !== serialized) {
        this.present("attention");
        return;
      }
      this.reference = config.secretReference;
      this.connect();
    } catch {
      this.present("attention");
    }
  }
  /** Changes only the non-secret selector; an armed owner requires reference stability (rotate native secret contents instead).
   * @param reference Native selector value, not a bearer.
   */
  setSecretReference(reference: string): void {
    this.reference = reference;
    const config = decodeDemoConfig(this.configurationText(), this.profile);
    if (config !== null)
      this.configure(JSON.stringify({ ...config, secretReference: reference }));
  }
  /** Invokes one bounded explicit command and suppresses stale presentation after unload/session replacement.
   * @returns Actual retained-owner outcome without upgrading pending/attention to completion.
   */
  async syncNow(): Promise<SyncDemoClientOutcome> {
    const owner = this.owner;
    const lease = this.lease;
    if (!this.alive || owner === null) {
      this.present(DEMO_PRESENTATION.notArmed);
      return "attention";
    }
    this.present(DEMO_PRESENTATION.syncing);
    const result = await owner.syncNow(lease);
    if (this.alive && this.lease === lease) this.present(result);
    return result;
  }
  /** Acquires compatible retained state and opens admission only after official layout readiness and existing listener registration. */
  private connect(): void {
    try {
      const config = decodeDemoConfig(
        readDemoString(this.app, this.profile.configKey),
        this.profile,
      );
      if (config === null) {
        this.present(DEMO_PRESENTATION.notArmed);
        return;
      }
      const owner = acquireDemoOwner(this.app, config, fetch, this.profile);
      if (owner === null) {
        this.present("attention");
        return;
      }
      this.owner?.detach(this.lease);
      this.owner = owner;
      this.reference = config.secretReference;
      const lease = owner.attach();
      this.lease = lease;
      this.app.workspace.onLayoutReady(() => {
        if (!this.alive || this.lease !== lease) return;
        owner.ready(lease);
        this.present(DEMO_PRESENTATION.ready);
      });
    } catch {
      this.present("attention");
    }
  }
  /** Renders only trusted fixed status categories through the official text surface, never HTML, tokens or note bodies. */
  private present(message: DemoPresentation): void {
    this.message = message;
    if (this.alive && this.bar !== null)
      this.bar.textContent = `Synthetic sync: ${message}`;
  }
}
