import type {
  Command,
  App as ObsidianApp,
  TFile as ObsidianTFile,
  PluginManifest,
  SettingDefinitionItem,
  TAbstractFile,
} from "obsidian";
import { vi } from "vitest";

/** Text-only DOM surface: markup APIs deliberately do not exist in this double. */
export class TextElement {
  textContent = "";
  readonly children: TextElement[] = [];
  readonly empty = vi.fn(() => {
    this.textContent = "";
    this.children.length = 0;
  });
  readonly createEl = vi.fn((tag: string, options: { text: string }) => {
    const child = new TextElement();
    child.textContent = options.text;
    this.children.push(child);
    return { tag, child };
  });
}

/** Typed initial selection and notices, widened without casting host objects. */
const initialUiState: { active: ObsidianTFile | null; notices: Notice[] } = {
  active: null,
  notices: [],
};

type VaultEventName = "create" | "modify" | "delete" | "rename";
type VaultListener = (file: TAbstractFile, oldPath?: string) => void;

class HostEventRef {
  /** @param detach - Exact listener cleanup owned by Plugin.registerEvent. */
  constructor(readonly detach: () => void) {}
}

/** Host-observable state, reset between isolated tests; never touches a real vault. */
export const host = {
  ...initialUiState,
  commands: new Map<string, Command>(),
  modals: new Set<Modal>(),
  settingsTabs: new Set<PluginSettingTab>(),
  statusBars: new Set<TextElement>(),
  settingRows: [] as Setting[],
  secretComponents: [] as SecretComponent[],
  files: new Map<string, ObsidianTFile>(),
  contents: new Map<ObsidianTFile, string>(),
  localStorage: new Map<string, unknown>(),
  secrets: new Map<string, string>(),
  vaultListeners: new Map<VaultEventName, Set<VaultListener>>(),
  layoutReady: false,
  layoutCallbacks: new Set<() => void>(),
  getActiveFile: vi.fn((): ObsidianTFile | null => host.active),
  vault: {
    configDir: "host-settings",
    getFiles: vi.fn((): ObsidianTFile[] => [...host.files.values()]),
    getAbstractFileByPath: vi.fn(
      (path: string): TAbstractFile | null => host.files.get(path) ?? null,
    ),
    read: vi.fn(
      async (file: ObsidianTFile): Promise<string> =>
        host.contents.get(file) ?? "",
    ),
    cachedRead: vi.fn(),
    create: vi.fn(),
    modify: vi.fn(),
    process: vi.fn(),
    delete: vi.fn(),
    trash: vi.fn(),
    rename: vi.fn(),
    createFolder: vi.fn(),
    on: vi.fn((name: VaultEventName, callback: VaultListener): HostEventRef => {
      const listeners = host.vaultListeners.get(name) ?? new Set();
      listeners.add(callback);
      host.vaultListeners.set(name, listeners);
      return new HostEventRef(() => listeners.delete(callback));
    }),
    adapter: {
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
    },
  },
  loadData: vi.fn(async (): Promise<unknown> => null),
  saveData: vi.fn(async (_data: unknown): Promise<void> => undefined),
  loadLocalStorage: vi.fn(
    (key: string): unknown => host.localStorage.get(key) ?? null,
  ),
  saveLocalStorage: vi.fn((key: string, value: unknown): void => {
    if (value === null) host.localStorage.delete(key);
    else host.localStorage.set(key, value);
  }),
  getSecret: vi.fn(
    (reference: string): string | null => host.secrets.get(reference) ?? null,
  ),
  setSecret: vi.fn((reference: string, value: string): void => {
    host.secrets.set(reference, value);
  }),
  listSecrets: vi.fn((): string[] => [...host.secrets.keys()]),
  request: vi.fn(),
  requestUrl: vi.fn(),
  saveEditor: vi.fn(),
  workspaceOn: vi.fn(),
  onLayoutReady: vi.fn((callback: () => void): void => {
    if (host.layoutReady) callback();
    else host.layoutCallbacks.add(callback);
  }),
  registerInterval: vi.fn(),
  emitVault(name: VaultEventName, file: TAbstractFile, oldPath?: string): void {
    for (const listener of host.vaultListeners.get(name) ?? []) {
      listener(file, oldPath);
    }
  },
  becomeLayoutReady(): void {
    host.layoutReady = true;
    for (const callback of [...host.layoutCallbacks]) callback();
    host.layoutCallbacks.clear();
  },
};

/** Official runtime App export replaced with only capabilities relevant to the tests. */
export class App {
  readonly vault = host.vault;
  readonly secretStorage = {
    getSecret: host.getSecret,
    setSecret: host.setSecret,
    listSecrets: host.listSecrets,
  };
  readonly loadLocalStorage = host.loadLocalStorage;
  readonly saveLocalStorage = host.saveLocalStorage;
  readonly workspace = {
    getActiveFile: host.getActiveFile,
    on: host.workspaceOn,
    onLayoutReady: host.onLayoutReady,
    activeEditor: { editor: { save: host.saveEditor } },
  };
}

/** Identity token used by the official bridge's instanceof check. */
export class TFile {}
/** Folder identity token used only for official lifecycle-event adaptation. */
export class TFolder {}

/** Models Component lifecycle and Plugin host-owned registrations. */
export class Plugin {
  private readonly cleanup: (() => void)[] = [];
  private loaded = false;
  readonly loadData = host.loadData;
  readonly saveData = host.saveData;
  readonly registerInterval = host.registerInterval;

  /** Retains host composition inputs just like the official Plugin constructor. */
  constructor(
    readonly app: ObsidianApp,
    readonly manifest: PluginManifest,
  ) {}

  /** Invokes and awaits the override only once per host enable. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.onload();
  }

  /** Runs the plugin hook and registered host disposers. */
  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    this.onunload();
    for (const dispose of this.cleanup.splice(0)) dispose();
  }

  /** Host hook overridden by the actual plugin. */
  onload(): Promise<void> | void {}
  /** Host hook overridden by the actual plugin. */
  onunload(): void {}

  /**
   * Registers one plugin-prefixed command with host cleanup ownership.
   * @param command - Product command definition.
   * @returns Host-qualified registered command.
   */
  addCommand(command: Command): Command {
    command.id = `${this.manifest.id}:${command.id}`;
    if (host.commands.has(command.id)) throw new Error("Duplicate command");
    host.commands.set(command.id, command);
    this.register(() => host.commands.delete(command.id));
    return command;
  }

  /** Registers one settings tab for this plugin lifetime. */
  addSettingTab(tab: PluginSettingTab): void {
    host.settingsTabs.add(tab);
    tab.update();
    this.register(() => host.settingsTabs.delete(tab));
  }

  /**
   * Adds one text-only status element with host cleanup ownership.
   * @returns Isolated status element double.
   */
  addStatusBarItem(): TextElement {
    const element = new TextElement();
    host.statusBars.add(element);
    this.register(() => host.statusBars.delete(element));
    return element;
  }

  /** Registers one official event reference for host cleanup ownership. */
  registerEvent(event: HostEventRef): void {
    this.register(event.detach);
  }

  /** @param dispose - Callback owned by this Component's unload lifecycle. */
  register(dispose: () => void): void {
    this.cleanup.push(dispose);
  }
}

/** Minimal modern declarative settings base. */
export class PluginSettingTab {
  settingItems: SettingDefinitionItem[] = [];
  /** @param app - Official app identity. @param plugin - Owning plugin. */
  constructor(
    readonly app: ObsidianApp,
    readonly plugin: Plugin,
  ) {}
  /** @returns Current declarative definitions. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }
  /** Refreshes definitions without rendering imperative controls in unit tests. */
  update(): void {
    this.settingItems = this.getSettingDefinitions();
  }
}

/** Fluent text-control double used by modern declarative render definitions. */
export class TextComponent {
  value = "";
  change: ((value: string) => unknown) | null = null;
  /**
   * @param _placeholder - Input placeholder text.
   * @returns This component after accepting placeholder text.
   */
  setPlaceholder(_placeholder: string): this {
    return this;
  }
  /**
   * @param value - Current input text.
   * @returns This component.
   */
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  /**
   * @param callback - Change handler.
   * @returns This component.
   */
  onChange(callback: (value: string) => unknown): this {
    this.change = callback;
    return this;
  }
}

/** Fluent textarea-control double. */
export class TextAreaComponent extends TextComponent {}

/** Fluent toggle-control double. */
export class ToggleComponent {
  value = false;
  change: ((value: boolean) => unknown) | null = null;
  /**
   * @param _tooltip - Toggle tooltip text.
   * @returns This component after accepting tooltip text.
   */
  setTooltip(_tooltip: string): this {
    return this;
  }
  /**
   * @param value - Current toggle value.
   * @returns This component.
   */
  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  /**
   * @param callback - Change handler.
   * @returns This component.
   */
  onChange(callback: (value: boolean) => unknown): this {
    this.change = callback;
    return this;
  }
}

/** Fluent button-control double. */
export class ButtonComponent {
  click: (() => unknown) | null = null;
  /**
   * @param _text - Visible button text.
   * @returns This component after accepting button text.
   */
  setButtonText(_text: string): this {
    return this;
  }
  /**
   * @param callback - Click handler.
   * @returns This component.
   */
  onClick(callback: () => unknown): this {
    this.click = callback;
    return this;
  }
}

/** Imperative row double used only by declarative render callbacks. */
export class Setting {
  errorMessage: string | null = null;
  readonly texts: TextComponent[] = [];
  readonly textareas: TextAreaComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  readonly buttons: ButtonComponent[] = [];
  /** @param _container - Optional declarative row container. */
  constructor(_container?: TextElement) {
    host.settingRows.push(this);
  }
  /**
   * @param message - Inline validation text.
   * @returns This row.
   */
  setErrorMessage(message: string | null): this {
    this.errorMessage = message;
    return this;
  }
  /**
   * @param callback - Text component initializer.
   * @returns This row.
   */
  addText(callback: (component: TextComponent) => unknown): this {
    const component = new TextComponent();
    this.texts.push(component);
    callback(component);
    return this;
  }
  /**
   * @param callback - Textarea initializer.
   * @returns This row.
   */
  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    const component = new TextAreaComponent();
    this.textareas.push(component);
    callback(component);
    return this;
  }
  /**
   * @param callback - Toggle initializer.
   * @returns This row.
   */
  addToggle(callback: (component: ToggleComponent) => unknown): this {
    const component = new ToggleComponent();
    this.toggles.push(component);
    callback(component);
    return this;
  }
  /**
   * @param callback - Button initializer.
   * @returns This row.
   */
  addButton(callback: (component: ButtonComponent) => unknown): this {
    const component = new ButtonComponent();
    this.buttons.push(component);
    callback(component);
    return this;
  }
  /**
   * @param callback - Custom component factory.
   * @returns This row.
   */
  addComponent(callback: (container: TextElement) => unknown): this {
    callback(new TextElement());
    return this;
  }
}

/** Minimal native secret-reference component for declarative definition loading. */
export class SecretComponent {
  value = "";
  change: ((value: string) => unknown) | null = null;
  /**
   * @param _app - Official app identity.
   * @param _container - Component container.
   */
  constructor(_app?: ObsidianApp, _container?: TextElement) {
    host.secretComponents.push(this);
  }
  /**
   * @param value - Native secret identifier.
   * @returns This fluent component.
   */
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  /**
   * @param callback - Secret-reference change callback.
   * @returns This component.
   */
  onChange(callback: (value: string) => unknown): this {
    this.change = callback;
    return this;
  }
}

/** Models open/close hooks; clearing content is the product's responsibility. */
export class Modal {
  readonly contentEl = new TextElement();
  readonly titleEl = new TextElement();
  /** Opens through the override, retaining visible modals for assertions. */
  open(): void {
    host.modals.add(this);
    this.onOpen();
  }
  /** Invokes the product close hook rather than automatically erasing its data. */
  close(): void {
    host.modals.delete(this);
    this.onClose();
  }
  /** Host hook overridden by product modals. */
  onOpen(): void {}
  /** Host hook overridden by product modals. */
  onClose(): void {}
}

/** Accepts strings only: passing markup fragments fails the test contract. */
export class Notice {
  hidden = false;
  /** Captures the text-only host notice for explicit UI assertions. */
  constructor(readonly message: string) {
    if (typeof message !== "string") throw new Error("Expected text notice");
    host.notices.push(this);
  }
  /** Records product-driven dismissal on replacement/unload. */
  hide(): void {
    this.hidden = true;
  }
}

/** Network API traps are present so accidental host requests cannot go unnoticed. */
export const request = host.request;
/** Obsidian's second network entry point is also observable. */
export const requestUrl = host.requestUrl;

/** Resets host data and spy implementations without adding product cleanup behavior. */
export function resetHost(): void {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  host.commands.clear();
  host.modals.clear();
  host.settingsTabs.clear();
  host.statusBars.clear();
  host.settingRows.length = 0;
  host.secretComponents.length = 0;
  host.notices.length = 0;
  host.files.clear();
  host.contents.clear();
  host.localStorage.clear();
  host.secrets.clear();
  host.vaultListeners.clear();
  host.layoutCallbacks.clear();
  host.layoutReady = false;
  host.active = null;
  host.getActiveFile.mockImplementation(() => host.active);
  host.vault.getFiles.mockImplementation(() => [...host.files.values()]);
  host.vault.getAbstractFileByPath.mockImplementation(
    (path) => host.files.get(path) ?? null,
  );
  host.vault.read.mockImplementation(
    async (file) => host.contents.get(file) ?? "",
  );
  host.loadData.mockResolvedValue(null);
  host.saveData.mockResolvedValue(undefined);
  host.loadLocalStorage.mockImplementation(
    (key) => host.localStorage.get(key) ?? null,
  );
  host.saveLocalStorage.mockImplementation((key, value) => {
    if (value === null) host.localStorage.delete(key);
    else host.localStorage.set(key, value);
  });
  host.getSecret.mockImplementation(
    (reference) => host.secrets.get(reference) ?? null,
  );
  host.onLayoutReady.mockImplementation((callback) => {
    if (host.layoutReady) callback();
    else host.layoutCallbacks.add(callback);
  });
}
