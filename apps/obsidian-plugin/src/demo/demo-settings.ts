import { DEMO_ACKNOWLEDGEMENT } from "@obsidian-plugin/demo/demo-config";
import type DemoPlugin from "@obsidian-plugin/demo/demo-main";
import {
  PluginSettingTab,
  SecretComponent,
  type SettingDefinitionItem,
} from "obsidian";

/** Declarative experimental controls use only native secrets and text-only configuration/status, never a custom bearer field. */
export class DemoSettings extends PluginSettingTab {
  /** Retains a non-secret JSON draft independently of durable activation; typing never performs sync. */
  private draft: string;
  /** Binds controls to the separate experimental plugin, not the release mirror session. */
  constructor(private readonly demo: DemoPlugin) {
    super(demo.app, demo);
    this.draft = demo.configurationText();
  }
  /** Offers explicit disposable acknowledgement, native-secret selection and bounded Sync now; remote scheduling has separate opt-in.
   * @returns Modern declarative render controls; typing/selecting does not dispatch network work.
   */
  override getSettingDefinitions(): SettingDefinitionItem<never>[] {
    const definitions: SettingDefinitionItem<never>[] = [
      {
        name: this.demo.automaticSyncAvailable()
          ? "Synthetic remote demo only"
          : "Synthetic local demo only",
        desc: this.demo.automaticSyncAvailable()
          ? `New disposable vaults only. Set acknowledgement to ${DEMO_ACKNOWLEDGEMENT}. Automatic sync stays off until separately enabled below.`
          : `New disposable vaults only. Set acknowledgement to ${DEMO_ACKNOWLEDGEMENT}. No background synchronization.`,
      },
      {
        name: "Experimental connection and target identities",
        desc: "JSON contains only mode, loopback endpoint, vaultId, deviceId, paths, secretReference and acknowledgement. Identity changes after arming require a fresh disposable experiment/full App restart; never erase the ledger.",
        render: (setting) => {
          setting.addTextArea((input) =>
            input.setValue(this.draft).onChange((text) => {
              this.draft = text;
            }),
          );
          setting.addButton((button) =>
            button
              .setButtonText("Apply disposable configuration")
              .onClick(() => {
                this.demo.configure(this.draft);
                this.update();
              }),
          );
        },
      },
      {
        name: "Native bearer secret",
        desc: "Select/create a SecretStorage entry and use its reference in the JSON. The bearer never enters plugin JSON or ledger.",
        render: (setting) => {
          setting.addComponent((container) =>
            new SecretComponent(this.app, container)
              .setValue(this.demo.secretReference())
              .onChange((reference) => {
                this.demo.setSecretReference(reference);
                this.draft = this.demo.configurationText();
              }),
          );
        },
      },
      {
        name: "Sync now",
        desc: this.demo.statusText(),
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Sync now").onClick(() => {
              void this.demo.syncNow().then(() => this.update());
            }),
          );
        },
      },
    ];
    if (this.demo.automaticSyncAvailable())
      definitions.push({
        name: "Automatic synthetic sync",
        desc: "Disposable remote artifact only. Explicit opt-in schedules saved-file events and a 60-second remote poll. Pending retries back off; attention stops automatic passes.",
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText(
                this.demo.automaticSyncEnabled()
                  ? "Disable automatic sync"
                  : "Enable automatic sync",
              )
              .onClick(() => {
                this.demo.setAutomaticSync(!this.demo.automaticSyncEnabled());
                this.update();
              }),
          );
        },
      });
    return definitions;
  }
}
