import { MIRROR_DEVICE_LIFECYCLE_KIND } from "@obsidian-ai-bridge/core";
import type { MirrorConfigurationController } from "@obsidian-plugin/configuration/mirror-configuration-controller";
import { validateMirrorEndpoint } from "@obsidian-plugin/configuration/mirror-endpoint";
import type { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import { formatMirrorOperationalStatus } from "@obsidian-plugin/status/mirror-status";
import {
  type App,
  type Plugin,
  PluginSettingTab,
  SecretComponent,
  type SettingDefinitionItem,
} from "obsidian";

/** Presentation hooks for explicit metadata-only settings actions. */
export interface MirrorSettingsPresentation {
  /** Shows one sanitized operational result. */
  showMessage(message: string): void;
  /** Shows explicit content-free handoff transfer text. */
  showHandoffExport(encoded: string): void;
}

/**
 * Modern declarative Obsidian settings for M3 operational configuration only.
 *
 * Custom rows are declared through 1.13's `render` definitions so endpoint and
 * exact-loopback consent save atomically and SecretComponent stores only a native
 * reference. Device authority and ledger state remain in App local storage.
 */
export class MirrorSettingsTab extends PluginSettingTab {
  private attached = true;

  /**
   * @param app - Official Obsidian App.
   * @param plugin - Owning plugin session.
   * @param configuration - Strict data.json controller.
   * @param owner - Runtime operational owner.
   * @param presentation - Text-only UI hooks.
   */
  constructor(
    app: App,
    plugin: Plugin,
    private readonly configuration: MirrorConfigurationController,
    private readonly owner: MirrorRuntimeOwner,
    private readonly presentation: MirrorSettingsPresentation,
  ) {
    super(app, plugin);
  }

  /** @inheritdoc */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Connection",
        items: [
          {
            name: "Bridge endpoint",
            desc: "HTTPS origin, or exact loopback HTTP origin with explicit development consent.",
            render: (setting) => {
              const current = this.configuration.current();
              let endpoint = current.origin ?? "";
              let allowLoopback =
                current.loopbackHttpOrigin !== null &&
                current.loopbackHttpOrigin === current.origin;
              setting.addText((component) =>
                component
                  .setPlaceholder("https://bridge.example.com")
                  .setValue(endpoint)
                  .onChange((value) => {
                    endpoint = value;
                    setting.setErrorMessage(null);
                  }),
              );
              setting.addToggle((component) =>
                component
                  .setTooltip(
                    "Allow this exact loopback HTTP origin for development",
                  )
                  .setValue(allowLoopback)
                  .onChange((value) => {
                    allowLoopback = value;
                    setting.setErrorMessage(null);
                  }),
              );
              setting.addButton((component) =>
                component.setButtonText("Save").onClick(() => {
                  const parsed = validateMirrorEndpoint(
                    endpoint,
                    allowLoopback,
                  );
                  if (parsed.kind !== "valid") {
                    setting.setErrorMessage(
                      "Enter an HTTPS origin or explicitly allow an exact loopback HTTP origin.",
                    );
                    return;
                  }
                  const preferences = this.configuration.current();
                  void this.configuration
                    .save({
                      ...preferences,
                      origin: parsed.origin,
                      loopbackHttpOrigin: allowLoopback ? parsed.origin : null,
                    })
                    .then((saved) => {
                      if (!this.attached) return;
                      setting.setErrorMessage(
                        saved
                          ? null
                          : "Connection settings could not be saved.",
                      );
                      this.update();
                    });
                }),
              );
            },
          },
          {
            name: "Bearer secret reference",
            desc: "Select a native SecretStorage entry. The bearer is never stored in data.json.",
            render: (setting) => {
              setting.addComponent((container) =>
                new SecretComponent(this.app, container)
                  .setValue(this.configuration.current().secretReference ?? "")
                  .onChange((reference) => {
                    const preferences = this.configuration.current();
                    void this.configuration
                      .save({
                        ...preferences,
                        secretReference:
                          reference.length === 0 ? null : reference,
                      })
                      .then((saved) => {
                        if (!this.attached) return;
                        setting.setErrorMessage(
                          saved ? null : "Secret reference could not be saved.",
                        );
                        this.update();
                      });
                  }),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Writer",
        items: [
          {
            name: "Enable whole eligible Markdown mirror",
            desc: "Activating confirms this is a newly provisioned empty association and authorizes automatic saved-note mirroring plus post-bootstrap runtime removals with 30-day recovery.",
            render: (setting) => {
              const active =
                this.owner.stateOwner.snapshot().state.lifecycle.kind ===
                MIRROR_DEVICE_LIFECYCLE_KIND.active;
              setting.addToggle((component) =>
                component.setValue(active).onChange((enabled) => {
                  const action = enabled
                    ? this.enableWriter()
                    : this.owner.pause();
                  void action.then((result) => {
                    if (!this.attached) return;
                    if (result.kind !== "completed") {
                      setting.setErrorMessage(
                        "Writer state was not changed. Verify configuration and designation.",
                      );
                    } else {
                      setting.setErrorMessage(null);
                    }
                    this.update();
                  });
                }),
              );
            },
          },
          {
            name: "Mirror status",
            desc: formatMirrorOperationalStatus(this.owner.status()),
          },
        ],
      },
      {
        type: "group",
        heading: "Writer handoff",
        items: [
          {
            name: "Prepare metadata-only handoff",
            desc: "Pauses and exports only quiescent acknowledgement metadata. It never includes note text, device activation, or bearer secrets.",
            action: () => {
              void this.owner.prepareHandoff().then((result) => {
                if (!this.attached) return;
                if (result.kind === "exported") {
                  this.presentation.showHandoffExport(result.encoded);
                } else {
                  this.presentation.showMessage(
                    "Handoff is not ready. Resolve pending or blocked work first.",
                  );
                }
                this.update();
              });
            },
          },
          {
            name: "Import metadata-only handoff",
            desc: "Explicitly verify transferred acknowledgements against this device and the designated Worker before activation.",
            render: (setting) => {
              let encoded = "";
              setting.addTextArea((component) =>
                component
                  .setPlaceholder("Paste AI Bridge handoff JSON")
                  .setValue("")
                  .onChange((value) => {
                    encoded = value;
                  }),
              );
              setting.addButton((component) =>
                component.setButtonText("Import").onClick(() => {
                  void this.owner.importHandoff(encoded).then((result) => {
                    if (!this.attached) return;
                    this.presentation.showMessage(
                      result.kind === "completed"
                        ? "Handoff verified and writer activated."
                        : "Handoff was not imported or activated.",
                    );
                    this.update();
                  });
                }),
              );
            },
          },
        ],
      },
    ];
  }

  /** Invalidates asynchronous callbacks when the plugin session unloads. */
  detach(): void {
    this.attached = false;
  }

  /** @returns The only lifecycle-valid explicit enable transition. */
  private enableWriter() {
    const lifecycle = this.owner.stateOwner.snapshot().state.lifecycle.kind;
    if (lifecycle === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) {
      return this.owner.activate();
    }
    if (lifecycle === MIRROR_DEVICE_LIFECYCLE_KIND.paused) {
      return this.owner.resume();
    }
    return Promise.resolve({ kind: "not-ready" } as const);
  }
}
