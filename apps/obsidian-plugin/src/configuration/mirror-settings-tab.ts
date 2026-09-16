import { MIRROR_DEVICE_LIFECYCLE_KIND } from "@obsidian-ai-bridge/core";
import type { MirrorConfigurationController } from "@obsidian-plugin/configuration/mirror-configuration-controller";
import { validateMirrorEndpoint } from "@obsidian-plugin/configuration/mirror-endpoint";
import type { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import {
  formatMirrorOperationalStatus,
  type MirrorOperationalStatus,
} from "@obsidian-plugin/status/mirror-status";
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
  private wholeMirrorConsentAccepted = false;

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
            name: "Local device / writer ID",
            desc: "Configure this non-secret UUID as the Worker's designated MIRROR_WRITER_ID.",
            render: (setting) => {
              setting.addText((component) => {
                component.setValue(this.owner.status().deviceId);
                component.inputEl.readOnly = true;
                return component;
              });
            },
          },
          {
            name: "Authenticated server identity",
            desc: formatServerIdentity(this.owner.status()),
            action: () => {
              void this.owner.verifyServerIdentity().then((result) => {
                if (!this.attached) return;
                this.presentation.showMessage(
                  result.kind === "completed"
                    ? "Server association and writer designation verified."
                    : "Server identity could not be verified.",
                );
                this.update();
              });
            },
          },
          {
            name: "Whole-mirror trust and deletion consent",
            desc: "I understand that the bearer-authenticated Worker receives the whole eligible Markdown mirror in plaintext; the Worker/cloud operator and trusted host or privileged plugins can read it. Saved runtime deletions, including iCloud or external deletions observed after bootstrap, authorize remote tombstones with 30-day recovery.",
            render: (setting) => {
              setting.addToggle((component) =>
                component
                  .setValue(this.wholeMirrorConsentAccepted)
                  .onChange((accepted) => {
                    this.wholeMirrorConsentAccepted = accepted;
                    setting.setErrorMessage(null);
                    this.update();
                  }),
              );
            },
          },
          {
            name: "Enable whole eligible Markdown mirror",
            desc: "First activation also confirms that this is a newly provisioned empty association. Activation remains unavailable until consent and server designation match.",
            render: (setting) => {
              const status = this.owner.status();
              const lifecycle =
                this.owner.stateOwner.snapshot().state.lifecycle.kind;
              const active = lifecycle === MIRROR_DEVICE_LIFECYCLE_KIND.active;
              const canEnable =
                this.wholeMirrorConsentAccepted &&
                status.serverIdentity.kind === "matched";
              setting.addToggle((component) =>
                component
                  .setValue(active)
                  .setDisabled(!active && !canEnable)
                  .onChange((enabled) => {
                    const action = enabled
                      ? this.enableWriter(this.wholeMirrorConsentAccepted)
                      : this.owner.pause();
                    void action.then((result) => {
                      if (!this.attached) return;
                      setting.setErrorMessage(
                        result.kind === "completed"
                          ? null
                          : "Writer state was not changed. Verify consent, configuration and designation.",
                      );
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
                  void this.owner
                    .importHandoff(encoded, this.wholeMirrorConsentAccepted)
                    .then((result) => {
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

  /**
   * @param explicitWholeMirrorConsent - Current explicit plaintext/scope consent.
   * @returns The only lifecycle-valid explicit enable transition.
   */
  private enableWriter(explicitWholeMirrorConsent: boolean) {
    const lifecycle = this.owner.stateOwner.snapshot().state.lifecycle.kind;
    if (lifecycle === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) {
      return this.owner.activate(explicitWholeMirrorConsent);
    }
    if (lifecycle === MIRROR_DEVICE_LIFECYCLE_KIND.paused) {
      return this.owner.resume();
    }
    return Promise.resolve({ kind: "not-ready" } as const);
  }
}

/**
 * Formats authenticated identity metadata without exposing credentials or errors.
 * @param status - Current sanitized runtime status.
 * @returns Plain-text association and designation status.
 */
function formatServerIdentity(status: MirrorOperationalStatus): string {
  switch (status.serverIdentity.kind) {
    case "unknown":
      return "Not verified. Use this action after configuring the endpoint and native secret reference.";
    case "unavailable":
      return "Authenticated server identity is unavailable.";
    case "matched":
      return `Association ${status.serverIdentity.associationId}; designated writer ${status.serverIdentity.designatedWriterId}; matches this device.`;
    case "mismatch":
      return `Association ${status.serverIdentity.associationId}; designated writer ${status.serverIdentity.designatedWriterId}; does not match local device ${status.deviceId}.`;
  }
}
