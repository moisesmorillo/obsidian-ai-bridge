import type {
  App,
  EventRef,
  PluginSettingTab,
  SecretComponent,
  SecretStorage,
  SettingDefinitionItem,
  TAbstractFile,
  Vault,
} from "obsidian";

/** Compile-time assertion used to pin required official declaration shapes. */
type Assert<Condition extends true> = Condition;

/** Vault event overloads required by the future M3 saved-file event adapter. */
interface RequiredVaultLifecycleEvents {
  /** Subscribes to saved vault creations, including folders. */
  on(name: "create", callback: (file: TAbstractFile) => void): EventRef;
  /** Subscribes to saved vault modifications, including folders. */
  on(name: "modify", callback: (file: TAbstractFile) => void): EventRef;
  /** Subscribes to saved vault removals, including folders. */
  on(name: "delete", callback: (file: TAbstractFile) => void): EventRef;
  /** Subscribes to renames with the pre-rename literal path. */
  on(
    name: "rename",
    callback: (file: TAbstractFile, oldPath: string) => void,
  ): EventRef;
}

/** App declarations required for host-local state and native secret references. */
interface RequiredHostStorage {
  /** Host-native secret service introduced before the M3 baseline. */
  readonly secretStorage: SecretStorage;
  /** Reads one vault-local host storage value at the adapter boundary. */
  loadLocalStorage(key: string): unknown;
  /** Writes or clears one representative serializable vault-local host storage value. */
  saveLocalStorage(key: string, data: string | null): void;
}

/** Native secret methods used to create, resolve, and enumerate references. */
interface RequiredSecretStorage {
  /** Stores a secret under the host's constrained identifier. */
  setSecret(id: string, secret: string): void;
  /** Resolves a secret only at its eventual use boundary. */
  getSecret(id: string): string | null;
  /** Lists references without exposing their values. */
  listSecrets(): string[];
}

/** Native reference-picker methods required by future modern settings. */
interface RequiredSecretComponent {
  /** Selects the referenced secret identifier, not its value. */
  setValue(value: string): SecretComponent;
  /** Observes a selected secret identifier. */
  onChange(callback: (value: string) => unknown): SecretComponent;
}

/** Declarative settings methods accepted for the Obsidian 1.13.0 baseline. */
interface RequiredDeclarativeSettings {
  /** Supplies framework-rendered setting definitions. */
  getSettingDefinitions(): SettingDefinitionItem[];
  /** Reads a setting value without weakly typed product propagation. */
  getControlValue(key: string): unknown;
  /** Persists a setting value through a future validated adapter. */
  setControlValue(key: string, value: unknown): void | Promise<void>;
}

/** Standards transport globals required before a future Fetch adapter is compiled. */
interface RequiredStandardsTransportGlobals {
  /** Browser Fetch entry point. */
  readonly fetch: typeof fetch;
  /** Browser abort-controller constructor. */
  readonly AbortController: typeof AbortController;
}

/** Confirms all four official Vault lifecycle overloads are installed. */
export type VaultLifecycleDeclarationQualified = Assert<
  Vault extends RequiredVaultLifecycleEvents ? true : false
>;

/** Confirms official vault-local and native secret App members are installed. */
export type HostStorageDeclarationQualified = Assert<
  App extends RequiredHostStorage ? true : false
>;

/** Confirms the installed native secret service surface. */
export type SecretStorageDeclarationQualified = Assert<
  SecretStorage extends RequiredSecretStorage ? true : false
>;

/** Confirms the installed native secret reference UI surface. */
export type SecretComponentDeclarationQualified = Assert<
  SecretComponent extends RequiredSecretComponent ? true : false
>;

/** Confirms the modern non-deprecated settings declaration surface. */
export type DeclarativeSettingsDeclarationQualified = Assert<
  PluginSettingTab extends RequiredDeclarativeSettings ? true : false
>;

/** Confirms standards Fetch and AbortController globals are declared. */
export type StandardsTransportDeclarationQualified = Assert<
  typeof globalThis extends RequiredStandardsTransportGlobals ? true : false
>;

/** Confirms Fetch responses expose nullable byte streams for bounded consumption. */
export type ResponseStreamDeclarationQualified = Assert<
  Response["body"] extends ReadableStream<Uint8Array> | null ? true : false
>;

/** Confirms response streams expose a reader for bounded incremental consumption. */
export type StreamReaderDeclarationQualified = Assert<
  ReturnType<
    ReadableStream<Uint8Array>["getReader"]
  > extends ReadableStreamReader<Uint8Array>
    ? true
    : false
>;

/** Confirms Fetch accepts the required redirect-refusal mode. */
export type RedirectErrorModeDeclarationQualified = Assert<
  "error" extends NonNullable<RequestInit["redirect"]> ? true : false
>;
