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
/** Automatic remote wake cadence; fixed polling also observes REST and peer edits without local events. */
export const DEMO_AUTO_POLL_MS = 60_000;
/** Saved events coalesce before one bounded pass. */
const DEMO_AUTO_EVENT_MS = 500;
/** First pending retry delay; later attempts double up to the fixed cap. */
const DEMO_AUTO_RETRY_MS = 1_000;
/** Finite accelerated retries can advance the synthetic journal without a tight loop. */
const DEMO_AUTO_RETRIES = 12;
/** Longest accelerated pending delay before the normal poll cadence takes over. */
const DEMO_AUTO_RETRY_CAP_MS = 10_000;
/** Maximum platform timer delay; a later wake rechecks any longer server floor. */
const DEMO_AUTO_MAX_TIMER_MS = 2_147_483_647;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private scheduleGeneration = 0;
  private retryCount = 0;
  private retryFloor = 0;
  private automaticStopped = false;
  private automaticFaultLatched = false;
  private automaticLease = 0;
  private runningAutomaticLease: number | null = null;
  private onAutomaticResult: ((result: SyncDemoClientOutcome) => void) | null =
    null;
  private readonly client: SyncDemoClient;
  private readonly ledger: SyncDemoLedgerRepository;
  private readonly transport: SyncDemoFetchRemote;
  /** Composes official capabilities but performs no network or local initialization before an explicit command. */
  constructor(
    private readonly app: App,
    private readonly config: DemoConfig,
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
    this.ledger = new SyncDemoLedgerRepository(
      {
        read: async () => readDemoString(app, key),
        write: async (value) => {
          app.saveLocalStorage(key, value);
        },
      },
      config,
    );
    this.client = new SyncDemoClient(
      this.ledger,
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
   * @param onAutomaticResult Current presenter's trusted status callback; detached sessions cannot receive later results.
   * @returns New execution/presentation lease, invalidating all predecessor leases.
   */
  attach(onAutomaticResult?: (result: SyncDemoClientOutcome) => void): number {
    this.cancelAutomatic();
    ++this.automaticLease;
    this.onAutomaticResult = onAutomaticResult ?? null;
    this.attached = true;
    this.layout = false;
    this.automaticStopped = this.automaticFaultLatched;
    this.retryCount = 0;
    this.retryFloor = 0;
    return ++this.lease;
  }
  /** Detaches only the current presenter; prior session cleanup cannot detach its successor.
   * @param token Exact session lease owned by the detaching plugin.
   */
  detach(token: number): void {
    if (token === this.lease) {
      this.cancelAutomatic();
      ++this.automaticLease;
      this.onAutomaticResult = null;
      this.attached = false;
      this.layout = false;
      ++this.lease;
    }
  }
  /** Opens observation coverage only after the current session installed listeners and reached layout-ready.
   * @param token Listener-owning lease reaching official layout readiness.
   */
  ready(token: number): void {
    if (token === this.lease && this.attached) {
      this.layout = true;
      this.scheduleAutomatic(token, DEMO_AUTO_EVENT_MS);
    }
  }
  /** Retains all saved metadata events as successor observations, with no own-event path/timing heuristic.
   * @param token Session that delivered the saved metadata event.
   * @param path Official event target; only an admitted path schedules automatic work.
   * @param oldPath Official rename source; an admitted source also schedules a conservative pass.
   */
  observed(token: number, path?: string, oldPath?: string): void {
    if (token === this.lease && this.attached) {
      ++this.events;
      if (
        this.config.paths.some(
          (admitted) => admitted === path || admitted === oldPath,
        )
      )
        this.scheduleAutomatic(token, DEMO_AUTO_EVENT_MS, true);
    }
  }
  /** Returns exact separately persisted opt-in, failing closed on corrupt/unreadable or changed binding state.
   * @returns Whether this immutable binding owns the saved remote opt-in.
   */
  automaticEnabled(): boolean {
    if (!this.profile.automaticKey) return false;
    try {
      return readDemoString(this.app, this.profile.automaticKey) === this.key;
    } catch {
      return false;
    }
  }
  /** Persists a remote-only toggle with exact read-back; disable cancels immediately without changing the original binding.
   * @param token Current listener-owning lease.
   * @param enabled Explicit user-selected automatic state.
   * @returns Whether the separate opt-in was read-back verified.
   */
  setAutomatic(token: number, enabled: boolean): boolean {
    const key = this.profile.automaticKey;
    if (!key || token !== this.lease || !this.attached || !this.layout)
      return false;
    this.cancelAutomatic();
    ++this.automaticLease;
    this.automaticStopped = true;
    this.automaticFaultLatched = true;
    try {
      const previous = readDemoString(this.app, key);
      if (
        enabled &&
        previous !== null &&
        previous !== "disabled" &&
        previous !== this.key
      )
        return false;
      const value = enabled ? this.key : "disabled";
      this.app.saveLocalStorage(key, value);
      if (readDemoString(this.app, key) !== value) return false;
      this.automaticFaultLatched = false;
      this.automaticStopped = !enabled;
      this.retryCount = 0;
      this.retryFloor = 0;
      if (enabled) this.scheduleAutomatic(token, DEMO_AUTO_EVENT_MS);
      return true;
    } catch {
      return false;
    }
  }
  /** Invalidates queued callback generations; an in-flight pass still settles through its original lease. */
  private cancelAutomatic(): void {
    ++this.scheduleGeneration;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = 0;
  }
  /** Schedules at most one owner wake, retaining an earlier pending wake under sustained host events.
   * @param token Current listener-owning lease.
   * @param delay Minimum delay in milliseconds before the wake.
   * @param preserveEarlier Whether a host event may retain an already earlier scheduled wake.
   */
  private scheduleAutomatic(
    token: number,
    delay: number,
    preserveEarlier = false,
  ): void {
    if (
      !this.profile.automaticKey ||
      this.automaticStopped ||
      !this.attached ||
      !this.layout ||
      token !== this.lease ||
      !this.automaticEnabled()
    )
      return;
    const wait = Math.max(delay, this.retryFloor - Date.now());
    const dueAt = Date.now() + Math.min(wait, DEMO_AUTO_MAX_TIMER_MS);
    if (
      preserveEarlier &&
      this.timer !== null &&
      this.timerDueAt <= dueAt &&
      this.timerDueAt >= this.retryFloor
    )
      return;
    this.cancelAutomatic();
    const generation = this.scheduleGeneration;
    this.timerDueAt = dueAt;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerDueAt = 0;
        if (generation === this.scheduleGeneration)
          void this.wakeAutomatic(token);
      },
      Math.min(wait, DEMO_AUTO_MAX_TIMER_MS),
    );
  }
  /** Runs one finite pass only while all original authority remains intact; attention and terminal admissions stop this owner.
   * @param token Current listener-owning lease.
   */
  private async wakeAutomatic(token: number): Promise<void> {
    if (!this.automaticAllowed(token)) {
      this.automaticStopped = true;
      this.automaticFaultLatched = true;
      this.cancelAutomatic();
      if (token === this.lease && this.attached)
        this.onAutomaticResult?.("attention");
      return;
    }
    if (this.isBusy()) {
      this.retryAutomatic(token);
      return;
    }
    const runLease = this.automaticLease;
    const durableFloor = await this.durableVaultRetryFloor();
    if (runLease !== this.automaticLease || token !== this.lease) return;
    if (durableFloor === null) {
      this.automaticStopped = true;
      this.automaticFaultLatched = true;
      this.cancelAutomatic();
      this.onAutomaticResult?.("attention");
      return;
    }
    const floor = Math.max(durableFloor, this.transport.retryFloorEpochMs());
    if (floor > Date.now()) {
      this.retryFloor = floor;
      this.scheduleAutomatic(token, floor - Date.now());
      return;
    }
    if (!this.automaticAllowed(token)) return;
    this.runningAutomaticLease = runLease;
    let result: SyncDemoClientOutcome;
    try {
      result = await this.syncNow(token);
    } finally {
      this.runningAutomaticLease = null;
    }
    if (runLease !== this.automaticLease || token !== this.lease) return;
    if (!this.automaticAllowed(token) || this.transport.isTerminal()) {
      this.automaticStopped = true;
      this.automaticFaultLatched = true;
      this.cancelAutomatic();
      if (
        runLease === this.automaticLease &&
        token === this.lease &&
        this.attached
      )
        this.onAutomaticResult?.("attention");
      return;
    }
    this.onAutomaticResult?.(result);
    switch (result) {
      case "settled":
        this.retryCount = 0;
        this.retryFloor = 0;
        this.scheduleAutomatic(token, DEMO_AUTO_POLL_MS);
        return;
      case "pending":
        this.retryAutomatic(token);
        return;
      case "attention":
        this.automaticStopped = true;
        this.automaticFaultLatched = true;
        this.cancelAutomatic();
        return;
    }
  }
  /** Applies finite exponential retry pacing, then resumes only on the fixed remote poll interval.
   * @param token Current listener-owning lease.
   */
  private retryAutomatic(token: number): void {
    this.retryCount = Math.min(this.retryCount + 1, DEMO_AUTO_RETRIES + 1);
    const delay =
      this.retryCount > DEMO_AUTO_RETRIES
        ? DEMO_AUTO_POLL_MS
        : Math.min(
            DEMO_AUTO_RETRY_CAP_MS,
            DEMO_AUTO_RETRY_MS * 2 ** (this.retryCount - 1),
          );
    this.retryFloor = Math.max(
      Date.now() + delay,
      this.transport.retryFloorEpochMs(),
    );
    this.scheduleAutomatic(token, this.retryFloor - Date.now());
  }
  /** Reads only shared vault-marker floors from verified ledger state; path-local prepared work cannot delay peers.
   * @returns Highest shared floor, or null when persistence authority is unavailable.
   */
  private async durableVaultRetryFloor(): Promise<number | null> {
    const loaded = await this.ledger.load();
    if (loaded.kind !== "ready") return null;
    return Math.max(
      0,
      ...loaded.ledger.entries.map((entry) =>
        entry.work?.kind === "push"
          ? (entry.work.vaultRetryAfterEpochMs ?? 0)
          : 0,
      ),
    );
  }
  /** Checks current opt-in, unchanged binding, ticket authority and session before every scheduled pass.
   * @param token Current listener-owning lease.
   * @returns Whether the original authority still permits a scheduled pass.
   */
  private automaticAllowed(token: number): boolean {
    if (
      !this.attached ||
      !this.layout ||
      token !== this.lease ||
      !this.automaticEnabled() ||
      this.transport.isTerminal() ||
      !this.profile.automaticAvailable?.(this.app, this.config)
    )
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
    if (
      this.runningAutomaticLease !== null &&
      (this.runningAutomaticLease !== this.automaticLease ||
        !this.automaticEnabled())
    )
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
    typeof value.isBusy === "function" &&
    "setAutomatic" in value &&
    typeof value.setAutomatic === "function" &&
    "automaticEnabled" in value &&
    typeof value.automaticEnabled === "function"
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
