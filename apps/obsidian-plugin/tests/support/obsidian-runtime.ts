import type {
  Command,
  App as ObsidianApp,
  TFile as ObsidianTFile,
  PluginManifest,
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

/** Host-observable state, reset between isolated tests; never touches a real vault. */
export const host = {
  ...initialUiState,
  commands: new Map<string, Command>(),
  modals: new Set<Modal>(),
  files: new Map<string, ObsidianTFile>(),
  contents: new Map<ObsidianTFile, string>(),
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
    on: vi.fn(),
    adapter: {
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
    },
  },
  loadData: vi.fn(),
  saveData: vi.fn(),
  request: vi.fn(),
  requestUrl: vi.fn(),
  saveEditor: vi.fn(),
  workspaceOn: vi.fn(),
  registerInterval: vi.fn(),
};

/** Official runtime App export replaced with only capabilities relevant to the tests. */
export class App {
  readonly vault = host.vault;
  readonly workspace = {
    getActiveFile: host.getActiveFile,
    on: host.workspaceOn,
    activeEditor: { editor: { save: host.saveEditor } },
  };
}

/** Identity token used by the official bridge's instanceof check. */
export class TFile {}

/** Models Component lifecycle and Plugin.addCommand ownership, not test-only cleanup. */
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

  /** Invokes the override only once per host enable. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
  }

  /** Runs the plugin hook and registered host disposers; never clears commands wholesale. */
  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    this.onunload();
    for (const dispose of this.cleanup.splice(0)) dispose();
  }

  /** Host hook overridden by the actual plugin. */
  onload(): void {}
  /** Host hook overridden by the actual plugin. */
  onunload(): void {}

  /**
   * Registers the plugin-prefixed command and its unload disposer, as the host does.
   * @param command - Fresh definition owned by this plugin instance.
   * @returns The registered definition with its host-qualified ID.
   */
  addCommand(command: Command): Command {
    command.id = `${this.manifest.id}:${command.id}`;
    if (host.commands.has(command.id)) throw new Error("Duplicate command");
    host.commands.set(command.id, command);
    this.register(() => host.commands.delete(command.id));
    return command;
  }

  /**
   * @param dispose - Callback owned by this Component's unload lifecycle.
   */
  register(dispose: () => void): void {
    this.cleanup.push(dispose);
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
  /** Host hook overridden by the list modal. */
  onOpen(): void {}
  /** Host hook overridden by the list modal. */
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
  host.notices.length = 0;
  host.files.clear();
  host.contents.clear();
  host.active = null;
  host.getActiveFile.mockImplementation(() => host.active);
  host.vault.getFiles.mockImplementation(() => [...host.files.values()]);
  host.vault.getAbstractFileByPath.mockImplementation(
    (path) => host.files.get(path) ?? null,
  );
  host.vault.read.mockImplementation(
    async (file) => host.contents.get(file) ?? "",
  );
}
