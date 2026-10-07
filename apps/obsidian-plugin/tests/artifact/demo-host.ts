import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createContext, Script } from "node:vm";

export class FileNode {
  constructor(readonly path: string) {}
}
export class FolderNode {
  constructor(readonly path: string) {}
}
type Node = FileNode | FolderNode;
type Listener = () => void;
export class SimVault {
  readonly configDir = ".obsidian";
  readonly nodes = new Map<string, Node>();
  readonly listeners = new Map<string, Set<Listener>>();
  beforeProcess: (() => void) | null = null;
  readonly effects: string[] = [];
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  getAllLoadedFiles(): Node[] {
    return [...this.nodes.values()];
  }
  getAbstractFileByPath(path: string): Node | null {
    return this.nodes.get(path) ?? null;
  }
  async read(file: FileNode): Promise<string> {
    return readFileSync(join(this.directory, file.path), "utf8");
  }
  async create(path: string, content: string): Promise<FileNode> {
    if (this.nodes.has(path)) throw new Error("Existing node");
    writeFileSync(join(this.directory, path), content, { flag: "wx" });
    const file = new FileNode(path);
    this.nodes.set(path, file);
    this.effects.push("create");
    this.emit("create");
    return file;
  }
  async createFolder(path: string): Promise<FolderNode> {
    mkdirSync(join(this.directory, path));
    const node = new FolderNode(path);
    this.nodes.set(path, node);
    this.emit("create");
    return node;
  }
  async process(
    file: FileNode,
    update: (saved: string) => string,
  ): Promise<string> {
    this.beforeProcess?.();
    this.beforeProcess = null;
    const text = update(await this.read(file));
    writeFileSync(join(this.directory, file.path), text);
    this.effects.push("process");
    this.emit("modify");
    return text;
  }
  async edit(file: FileNode, text: string): Promise<void> {
    writeFileSync(join(this.directory, file.path), text);
    this.emit("modify");
  }
  on(event: string, callback: Listener): { detach: Listener } {
    const callbacks = this.listeners.get(event) ?? new Set<Listener>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return { detach: () => callbacks.delete(callback) };
  }
  emit(event: string): void {
    for (const callback of this.listeners.get(event) ?? []) callback();
  }
}
export class SimApp {
  readonly vault: SimVault;
  readonly inputs: TextInput[] = [];
  readonly secretControls: SecretComponent[] = [];
  readonly secrets = new Map<string, string>();
  readonly secretStorage = {
    getSecret: (name: string) => this.secrets.get(name) ?? null,
  };
  readonly workspace = { onLayoutReady: (callback: Listener) => callback() };
  constructor(
    readonly directory: string,
    vault?: SimVault,
  ) {
    mkdirSync(directory, { recursive: true });
    this.vault = vault ?? new SimVault(join(directory, "vault"));
  }
  loadLocalStorage(key: string): unknown {
    try {
      return readFileSync(this.slot(key), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  saveLocalStorage(key: string, value: string): void {
    writeFileSync(this.slot(key), value);
  }
  private slot(key: string): string {
    return join(
      this.directory,
      `app-local-${Buffer.from(key).toString("base64url")}.json`,
    );
  }
}
interface Manifest {
  readonly id: string;
}
export class TextNode {
  textContent = "";
}
export class Button {
  text = "";
  callback: Listener | null = null;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  onClick(callback: Listener): this {
    this.callback = callback;
    return this;
  }
  click(): void {
    this.callback?.();
  }
}
class TextInput {
  value = "";
  callback: ((text: string) => void) | null = null;
  setValue(text: string): this {
    this.value = text;
    return this;
  }
  onChange(callback: (text: string) => void): this {
    this.callback = callback;
    return this;
  }
  change(text: string): void {
    this.value = text;
    this.callback?.(text);
  }
}
class SettingRow {
  constructor(
    private readonly controls: Button[],
    private readonly inputs: TextInput[],
  ) {}
  addTextArea(callback: (input: TextInput) => void): this {
    const input = new TextInput();
    this.inputs.push(input);
    callback(input);
    return this;
  }
  addButton(callback: (button: Button) => void): this {
    const button = new Button();
    callback(button);
    this.controls.push(button);
    return this;
  }
  addComponent(callback: (container: object) => object): this {
    callback({});
    return this;
  }
}
interface Definition {
  readonly name: string;
  readonly render?: (setting: SettingRow) => void;
}
class SecretComponent {
  callback: ((reference: string) => void) | null = null;
  constructor(app: SimApp, _container: object) {
    app.secretControls.push(this);
  }
  setValue(_reference: string): this {
    return this;
  }
  onChange(callback: (reference: string) => void): this {
    this.callback = callback;
    return this;
  }
  change(reference: string): void {
    this.callback?.(reference);
  }
}
class SettingsTab {
  constructor(
    readonly app: SimApp,
    readonly plugin: HostPlugin,
  ) {}
  getSettingDefinitions(): Definition[] {
    return [];
  }
  update(): void {
    this.plugin.buttons.length = 0;
    for (const definition of this.getSettingDefinitions())
      definition.render?.(new SettingRow(this.plugin.buttons, this.app.inputs));
  }
}
class HostPlugin {
  readonly buttons: Button[] = [];
  readonly statuses: TextNode[] = [];
  readonly commands = new Map<string, Listener>();
  private readonly cleanup: Listener[] = [];
  constructor(
    readonly app: SimApp,
    readonly manifest: Manifest,
  ) {}
  onload(): void {}
  onunload(): void {}
  unload(): void {
    this.onunload();
    for (const callback of this.cleanup.splice(0)) callback();
  }
  addStatusBarItem(): TextNode {
    const bar = new TextNode();
    this.statuses.push(bar);
    return bar;
  }
  registerEvent(ref: { detach: Listener }): void {
    this.cleanup.push(ref.detach);
  }
  addCommand(command: { id: string; callback: Listener }): void {
    this.commands.set(command.id, command.callback);
  }
  addSettingTab(tab: SettingsTab): void {
    tab.update();
  }
}
export interface ArtifactPlugin {
  onload(): void;
  unload(): void;
  configure(text: string): void;
  syncNow(): Promise<string>;
  statusText(): string;
  readonly buttons: Button[];
  readonly statuses: TextNode[];
  readonly commands: Map<string, Listener>;
}
export function isPlugin(value: unknown): value is ArtifactPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "onload" in value &&
    typeof value.onload === "function" &&
    "unload" in value &&
    typeof value.unload === "function" &&
    "configure" in value &&
    typeof value.configure === "function" &&
    "syncNow" in value &&
    typeof value.syncNow === "function" &&
    "statusText" in value &&
    typeof value.statusText === "function" &&
    "buttons" in value &&
    Array.isArray(value.buttons) &&
    "statuses" in value &&
    Array.isArray(value.statuses) &&
    "commands" in value &&
    value.commands instanceof Map
  );
}
export function artifactRealm(
  bundle: string,
  app: SimApp,
  fetcher: typeof fetch,
) {
  const module: { exports: unknown } = { exports: {} };
  const allowed = {
    Plugin: HostPlugin,
    PluginSettingTab: SettingsTab,
    SecretComponent,
    TFile: FileNode,
    TFolder: FolderNode,
  };
  const context = createContext({
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name !== "obsidian") throw new Error("Unexpected dependency");
      return allowed;
    },
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetcher,
  });
  return {
    load(): ArtifactPlugin {
      new Script(bundle).runInContext(context);
      const exported: unknown = module.exports;
      if (
        typeof exported !== "object" ||
        exported === null ||
        !("default" in exported) ||
        typeof exported.default !== "function"
      )
        throw new Error("Invalid artifact export");
      const plugin: unknown = Reflect.construct(exported.default, [
        app,
        { id: "ai-bridge-synthetic-demo" },
      ]);
      if (!isPlugin(plugin)) throw new Error("Invalid artifact surface");
      plugin.onload();
      return plugin;
    },
  };
}
export const simulatedObsidian = {
  Plugin: HostPlugin,
  PluginSettingTab: SettingsTab,
  SecretComponent,
  TFile: FileNode,
  TFolder: FolderNode,
};
export function ensureParent(directory: string, path: string): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
}
