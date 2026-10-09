import {
  SyncDemoClient,
  type SyncDemoClientOutcome,
  type SyncDemoRemote,
} from "@obsidian-ai-bridge/core";
import {
  syncOperationIdSchema,
  syncRevisionSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  type DemoConfig,
  type DemoProfile,
  decodeDemoConfig,
  demoLedgerKey,
  LOCAL_DEMO_PROFILE,
  readDemoString,
} from "@obsidian-plugin/demo/demo-config";
import { DemoLocal } from "@obsidian-plugin/demo/demo-local";
import { SyncDemoFetchRemote } from "@obsidian-plugin/demo/sync-demo-fetch";
import { SyncDemoLedgerRepository } from "@obsidian-plugin/demo/sync-demo-ledger";
import type { App } from "obsidian";

/** Compatible same-realm slot contains only retained owners, never serializable credentials or diagnostics. */
interface DemoRegistry {
  readonly version: 1;
  readonly owners: WeakMap<object, unknown>;
}
/** Owns a single original configuration, client and unsettled permit through plugin/bundle replacement. */
export class DemoOwner {
  /** Structural cross-bundle compatibility version, not a persistence migration version. */
  readonly version = 1;
  /** Exact configuration fingerprint; changing identity/endpoint/reference/paths cannot redirect retained work. */
  readonly key: string;
  private lease = 0;
  private attached = false;
  private layout = false;
  private running: number | null = null;
  private events = 0;
  private readonly client: SyncDemoClient;
  private readonly transport: SyncDemoFetchRemote;
  /** Composes official capabilities but performs no network or local initialization before an explicit command. */
  constructor(
    private readonly app: App,
    config: DemoConfig,
    fetcher: typeof fetch = fetch,
    private readonly profile: DemoProfile = LOCAL_DEMO_PROFILE,
  ) {
    this.key = JSON.stringify(config);
    this.transport = new SyncDemoFetchRemote(
      config.endpoint,
      config,
      async () => {
        if (!this.allowed()) return null;
        const secret = this.app.secretStorage.getSecret(config.secretReference);
        return this.allowed() ? secret : null;
      },
      (input, init) => {
        if (!this.allowed())
          return Promise.reject(new TypeError("Inactive demo execution."));
        return fetcher(input, init);
      },
      undefined,
      profile.ticket
        ? {
            endpoint: config.endpoint,
            ticket: () =>
              this.allowed() ? (profile.ticket?.(app, config) ?? null) : null,
          }
        : undefined,
    );
    const remote: SyncDemoRemote = {
      beginPass: () => this.transport.beginPass(),
      current: (path) =>
        this.allowed()
          ? this.transport.current(path)
          : Promise.resolve({ kind: "error", code: "invalid_input" }),
      version: (revision) =>
        this.allowed()
          ? this.transport.version(revision)
          : Promise.resolve({ kind: "error", code: "invalid_input" }),
      mutate: (request) =>
        this.allowed()
          ? this.transport.mutate(request)
          : Promise.resolve({ kind: "error", code: "invalid_input" }),
      changes: (cursor) =>
        this.allowed()
          ? this.transport.changes(cursor)
          : Promise.resolve({ kind: "error", code: "invalid_input" }),
    };
    const key = demoLedgerKey(config, profile);
    const ledger = new SyncDemoLedgerRepository(
      {
        read: async () => readDemoString(app, key),
        write: async (value) => {
          app.saveLocalStorage(key, value);
        },
      },
      config,
    );
    this.client = new SyncDemoClient(
      ledger,
      new DemoLocal(app.vault, () => this.allowed()),
      remote,
      {
        binding: config,
        now: Date.now,
        operationId: () => syncOperationIdSchema.parse(crypto.randomUUID()),
        revision: () => syncRevisionSchema.parse(crypto.randomUUID()),
      },
    );
  }
  /** Starts a listener-owning session without clearing any pending work or unsettled transport.
   * @returns New execution/presentation lease, invalidating all predecessor leases.
   */
  attach(): number {
    this.attached = true;
    this.layout = false;
    return ++this.lease;
  }
  /** Detaches only the current presenter; prior session cleanup cannot detach its successor.
   * @param token Exact session lease owned by the detaching plugin.
   */
  detach(token: number): void {
    if (token === this.lease) {
      this.attached = false;
      this.layout = false;
      ++this.lease;
    }
  }
  /** Opens observation coverage only after the current session installed listeners and reached layout-ready.
   * @param token Listener-owning lease reaching official layout readiness.
   */
  ready(token: number): void {
    if (token === this.lease && this.attached) this.layout = true;
  }
  /** Retains all saved metadata events as successor observations, with no own-event path/timing heuristic.
   * @param token Session that delivered the saved metadata event.
   */
  observed(token: number): void {
    if (token === this.lease && this.attached) ++this.events;
  }
  /** Excludes a successor command until both coordinator settlement and late transport/body work settle.
   * @returns Whether unsettled work still owns admission across presentation replacement.
   */
  isBusy(): boolean {
    return this.running !== null || this.transport.isBusy();
  }
  /** Runs one finite explicit command; a saved event during the pass remains visible as pending next observation.
   * @param token Current ready session requesting bounded progress.
   * @returns Settled/pending/attention without optimistic effect certainty.
   */
  async syncNow(token: number): Promise<SyncDemoClientOutcome> {
    if (!this.attached || !this.layout || token !== this.lease)
      return "attention";
    if (this.isBusy()) return "pending";
    this.running = token;
    const before = this.events;
    try {
      const result = await this.client.syncNow();
      return result === "settled" && before !== this.events
        ? "pending"
        : result;
    } catch {
      return "attention";
    } finally {
      this.running = null;
    }
  }
  /** Rechecks current execution lease and exact host-local arming immediately before every later local/remote dispatch.
   * @returns Whether the running original configuration is still the attached listener-ready session.
   */
  private allowed(): boolean {
    if (!this.attached || !this.layout || this.running !== this.lease)
      return false;
    try {
      const current = decodeDemoConfig(
        readDemoString(this.app, this.profile.configKey),
        this.profile,
      );
      return current !== null && JSON.stringify(current) === this.key;
    } catch {
      return false;
    }
  }
}
/** Validates only the cross-bundle callable compatibility surface at the isolated global boundary; no incompatible owner is replaced.
 * @param value Untrusted predecessor bundle owner.
 * @returns Whether the exact version and required callable surface can be reused.
 */
function isOwner(value: unknown): value is DemoOwner {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "key" in value &&
    typeof value.key === "string" &&
    "attach" in value &&
    typeof value.attach === "function" &&
    "detach" in value &&
    typeof value.detach === "function" &&
    "ready" in value &&
    typeof value.ready === "function" &&
    "observed" in value &&
    typeof value.observed === "function" &&
    "syncNow" in value &&
    typeof value.syncNow === "function" &&
    "isBusy" in value &&
    typeof value.isBusy === "function"
  );
}
/** Validates the own data-property registry format and same-realm WeakMap; accessors and unsupported versions fail closed.
 * @param value Untrusted own data-property value, never an invoked accessor.
 * @returns Whether the versioned same-realm registry is structurally compatible.
 */
function isRegistry(value: unknown): value is DemoRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "owners" in value &&
    value.owners instanceof WeakMap
  );
}
/** Acquires one retained owner for the actual App identity; config changes or incompatible global state cannot erase exclusion.
 * @returns Compatible retained/new owner or null without overwriting existing ownership.
 */
export function acquireDemoOwner(
  app: App,
  config: DemoConfig,
  fetcher: typeof fetch = fetch,
  profile: DemoProfile = LOCAL_DEMO_PROFILE,
): DemoOwner | null {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    profile.ownerSymbol,
  );
  const existing: unknown = descriptor?.value;
  if (descriptor !== undefined && !isRegistry(existing)) return null;
  const registry = isRegistry(existing)
    ? existing
    : { version: 1 as const, owners: new WeakMap<object, unknown>() };
  if (descriptor === undefined)
    Object.defineProperty(globalThis, profile.ownerSymbol, {
      value: registry,
      configurable: false,
      writable: false,
    });
  const retained = registry.owners.get(app);
  if (retained !== undefined)
    return isOwner(retained) && retained.key === JSON.stringify(config)
      ? retained
      : null;
  const owner = new DemoOwner(app, config, fetcher, profile);
  registry.owners.set(app, owner);
  return owner;
}
