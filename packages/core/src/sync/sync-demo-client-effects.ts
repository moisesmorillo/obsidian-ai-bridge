import type { ContentSha256 } from "@core/mirror/mirror.types";
import { createContentSha256 } from "@core/mirror/mirror-identifiers";
import type { SyncNotePath } from "@core/sync/sync.types";
import type {
  SyncDemoClientEnvironment,
  SyncDemoLedgerStore,
  SyncDemoLocal,
  SyncDemoRemote,
} from "@core/sync/sync-demo-client.port";
import type {
  SyncDemoBase,
  SyncDemoClientOutcome,
  SyncDemoEntry,
  SyncDemoLedger,
  SyncDemoPush,
} from "@core/sync/sync-demo-client.types";
import type {
  SyncLiveCurrentState,
  SyncMutationParent,
  SyncVersionRecord,
} from "@core/sync/sync-store.types";

/** Finite synthetic client policy; shared transport admission derives its path/body ceilings from this authority. */
export const SYNC_DEMO_CLIENT_LIMITS = {
  paths: 3,
  contentBytes: 16 * 1024,
  requests: 32,
} as const;
/** Complete well-formed saved-body admission; hashing never silently replaces a lone surrogate.
 * @param content Saved transient Markdown, never persisted by this client.
 * @returns Whether exact UTF-8 encoding fits the synthetic body ceiling.
 */
export function isSyncDemoContent(content: string): boolean {
  return (
    content.isWellFormed() &&
    new TextEncoder().encode(content).byteLength <=
      SYNC_DEMO_CLIENT_LIMITS.contentBytes
  );
}
/** Computes the SHA-256 identity of exact admitted UTF-8 bytes; provider/admission failures close effects.
 * @param content Well-formed transient saved Markdown within the lab ceiling.
 * @returns Validated SHA-256 identity without whitespace/newline normalization.
 */
export async function hashSyncDemoContent(
  content: string,
): Promise<ContentSha256> {
  if (!isSyncDemoContent(content))
    throw new TypeError("Invalid synthetic Markdown.");
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
  );
  const digest = createContentSha256(
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  if (digest === undefined)
    throw new TypeError("Unavailable content identity.");
  return digest;
}
/** Exact parent equality for immutable linkage and original-request reconstruction, never parent refresh.
 * @param left Original durable or immutable parent evidence.
 * @param right Candidate evidence to compare without reinterpretation.
 * @returns Whether both predicates address the same exact generation/absence.
 */
function sameParent(
  left: SyncMutationParent,
  right: SyncMutationParent,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "never_seen" ||
      (right.kind === "revision" && left.revision === right.revision))
  );
}
/** Live transient version type; tombstones cannot reach a local write capability. */
type LiveVersion = Extract<SyncVersionRecord, { readonly kind: "live" }>;

/** Prepared-effect executor owns verified persistence, original-request replay and preservation; one serialized pass owns it. */
export class SyncDemoClientEffects {
  /** Unverified persistence revokes every subsequent effect in this pass without publishing speculative state. */
  private fenced = false;
  /** Captures the freshly rehydrated content-free state; no in-memory transition is published before read-back proof. */
  constructor(
    private ledger: SyncDemoLedger,
    private readonly store: SyncDemoLedgerStore,
    private readonly local: SyncDemoLocal,
    private readonly remote: SyncDemoRemote,
    private readonly environment: SyncDemoClientEnvironment,
  ) {}
  /** Returns the latest verified whole-ledger value, never a speculative save.
   * @returns Exact last read-back-verified state for this pass.
   */
  get state(): SyncDemoLedger {
    return this.ledger;
  }
  /** Persists one entry transition and fences all later effects if proof fails.
   * @param entry Exact successor for an already bound path.
   * @returns Whether the complete replacement ledger was durably verified.
   */
  async saveEntry(entry: SyncDemoEntry): Promise<boolean> {
    return this.save({
      ...this.ledger,
      entries: this.ledger.entries.map((prior) =>
        prior.path === entry.path ? entry : prior,
      ),
    });
  }
  /** Advances only a completely settled page's exact original next cursor.
   * @param cursor Unmodified next checkpoint from the settled page.
   * @returns Whether checkpoint persistence was verified.
   */
  async saveCursor(cursor: string): Promise<boolean> {
    return this.save({ ...this.ledger, cursor });
  }
  /** Writes a complete transition through the sole persistence authority; failure certainty never grants effects.
   * @param ledger Fully bound successor state, never partial metadata.
   * @returns Whether verified persistence permits publication in this owner.
   */
  private async save(ledger: SyncDemoLedger): Promise<boolean> {
    if (this.fenced) return false;
    if (!(await this.store.save(ledger))) {
      this.fenced = true;
      return false;
    }
    this.ledger = ledger;
    return true;
  }
  /** Verifies immutable vault/path/revision/hash/size and optional complete head linkage before returning transient bytes.
   * @param path Bound synthetic path whose bytes are required.
   * @param target Original revision/hash evidence, never a guessed latest version.
   * @param head Optional current metadata whose complete immutable linkage must match.
   * @returns Verified live bytes or null; tombstones/failures never grant a write.
   */
  async version(
    path: SyncNotePath,
    target: SyncDemoBase,
    head?: SyncLiveCurrentState,
  ): Promise<LiveVersion | null> {
    const response = await this.remote.version(target.revision);
    if (response.kind !== "present" || response.version.kind !== "live")
      return null;
    const version = response.version;
    if (
      version.vaultId !== this.ledger.vaultId ||
      version.path !== path ||
      version.revision !== target.revision ||
      version.contentSha256 !== target.contentSha256 ||
      !isSyncDemoContent(version.content) ||
      version.byteSize !==
        new TextEncoder().encode(version.content).byteLength ||
      (await hashSyncDemoContent(version.content)) !== version.contentSha256
    )
      return null;
    if (
      head &&
      (version.operationId !== head.operationId ||
        version.origin !== head.origin ||
        version.byteSize !== head.byteSize ||
        version.mediaType !== head.mediaType ||
        !sameParent(version.parent, head.parent))
    )
      return null;
    return version;
  }
  /** Admits a new exact-parent request once; saves original IDs/hash before any remote dispatch.
   * @param entry Idle bound path and its exact acknowledged parent.
   * @param content Fresh positive saved observation to publish conditionally.
   * @returns Committed settlement, durable pending work or attention.
   */
  async push(
    entry: SyncDemoEntry,
    content: string,
  ): Promise<SyncDemoClientOutcome> {
    const work: SyncDemoPush = {
      kind: "push",
      certainty: "uncertain",
      operationId: this.environment.operationId(),
      revision: this.environment.revision(),
      parent:
        entry.base === null
          ? { kind: "never_seen" }
          : { kind: "revision", revision: entry.base.revision },
      contentSha256: await hashSyncDemoContent(content),
      retryAfterEpochMs: 0,
    };
    const next = { ...entry, work };
    if (!(await this.saveEntry(next))) return "attention";
    return this.recoverPush(next);
  }
  /** Replays only original bytes/tuple at the persisted floor; explicit pre-journal refusal requires unchanged saved bytes, and uncertain version presence never proves commit.
   * @param entry Original durable push identity and exact parent/hash/floor.
   * @returns Matching commit settlement or conservative pending/attention without replacement bytes.
   */
  async recoverPush(entry: SyncDemoEntry): Promise<SyncDemoClientOutcome> {
    const work = entry.work;
    if (work?.kind !== "push" || this.fenced) return "attention";
    if (this.environment.now() < work.retryAfterEpochMs) return "pending";
    const observed = await this.local.observe(entry.path);
    if (observed.kind === "blocked") return "attention";
    let content: string;
    if (
      observed.kind === "live" &&
      isSyncDemoContent(observed.content) &&
      (await hashSyncDemoContent(observed.content)) === work.contentSha256
    )
      content = observed.content;
    else {
      if (work.certainty === "not_admitted") return "attention";
      const version = await this.version(entry.path, work);
      if (
        version === null ||
        version.operationId !== work.operationId ||
        version.origin !== this.ledger.deviceId ||
        !sameParent(version.parent, work.parent)
      )
        return "attention";
      content = version.content;
    }
    const identity = {
      vaultId: this.ledger.vaultId,
      path: entry.path,
      origin: this.ledger.deviceId,
      operationId: work.operationId,
      revision: work.revision,
      contentSha256: work.contentSha256,
      content,
      mediaType: "text/markdown" as const,
    };
    const outcome = await this.remote.mutate(
      work.parent.kind === "never_seen"
        ? { ...identity, kind: "create", parent: work.parent }
        : { ...identity, kind: "update", parent: work.parent },
    );
    if (outcome.kind === "committed") {
      if (
        outcome.revision !== work.revision ||
        outcome.operationId !== work.operationId
      )
        return "attention";
      if (
        !(await this.saveEntry({
          ...entry,
          base: { revision: work.revision, contentSha256: work.contentSha256 },
          work: null,
        }))
      )
        return "attention";
      const saved = await this.local.observe(entry.path);
      return saved.kind === "live" &&
        isSyncDemoContent(saved.content) &&
        (await hashSyncDemoContent(saved.content)) === work.contentSha256
        ? "settled"
        : "pending";
    }
    if (
      "operationId" in outcome &&
      outcome.operationId !== undefined &&
      outcome.operationId !== work.operationId
    )
      return "attention";
    if (outcome.code === "stale_revision") {
      const current = await this.remote.current(entry.path);
      if (current.kind !== "live") return "attention";
      const version = await this.version(entry.path, current, current);
      return version === null ? "attention" : this.conflict(entry, version);
    }
    if (
      ![
        "effect_unknown",
        "operation_pending",
        "mutation_not_admitted",
        "storage_unavailable",
        "storage_throttled",
      ].includes(outcome.code)
    )
      return "attention";
    const floor =
      "retryAfterEpochMs" in outcome ? (outcome.retryAfterEpochMs ?? 0) : 0;
    const vaultFloor =
      "retryScope" in outcome && outcome.retryScope === "vault"
        ? Math.max(work.vaultRetryAfterEpochMs ?? 0, floor)
        : work.vaultRetryAfterEpochMs;
    return (await this.saveEntry({
      ...entry,
      work: {
        ...work,
        certainty:
          outcome.code === "mutation_not_admitted"
            ? "not_admitted"
            : "uncertain",
        retryAfterEpochMs: Math.max(work.retryAfterEpochMs, floor),
        ...(vaultFloor === undefined
          ? {}
          : { vaultRetryAfterEpochMs: vaultFloor }),
      },
    }))
      ? "pending"
      : "attention";
  }
  /** Saves prepared compare-and-replace authority, dispatches once and settles only a freshly verified exact postcondition.
   * @param entry Idle path with exact base authority.
   * @param version Verified remote target; bytes remain transient.
   * @param expected Exact acknowledged bytes, or null for fresh create-only absence.
   * @returns Verified local settlement, retained prepared work or preserved refusal.
   */
  async apply(
    entry: SyncDemoEntry,
    version: LiveVersion,
    expected: string | null,
  ): Promise<SyncDemoClientOutcome> {
    const next: SyncDemoEntry = {
      ...entry,
      work: {
        kind: "apply",
        target: {
          revision: version.revision,
          contentSha256: version.contentSha256,
        },
        expectedHash: entry.base?.contentSha256 ?? null,
      },
    };
    if (!(await this.saveEntry(next))) return "attention";
    const result = await this.local.apply(
      entry.path,
      expected,
      version.content,
    );
    if (result === "refused") return this.conflict(entry, version);
    const saved = await this.local.observe(entry.path);
    if (saved.kind !== "live" || saved.content !== version.content)
      return "pending";
    return (await this.saveEntry({
      ...entry,
      base: {
        revision: version.revision,
        contentSha256: version.contentSha256,
      },
      work: null,
    }))
      ? "settled"
      : "attention";
  }
  /** Cold-start recovery checks the exact prepared target, never replays a local effect from missing/divergent evidence.
   * @param entry Original prepared local effect, unchanged across restart.
   * @returns Settlement only for its exact saved postcondition, otherwise attention.
   */
  async recoverApply(entry: SyncDemoEntry): Promise<SyncDemoClientOutcome> {
    if (entry.work?.kind !== "apply") return "attention";
    const version = await this.version(entry.path, entry.work.target);
    const saved = await this.local.observe(entry.path);
    if (
      version === null ||
      saved.kind !== "live" ||
      saved.content !== version.content
    )
      return "attention";
    return (await this.saveEntry({
      ...entry,
      base: entry.work.target,
      work: null,
    }))
      ? "settled"
      : "attention";
  }
  /** Persists preservation work before create-only dispatch and exact reread; local/base remain untouched and attention stays visible.
   * @param entry Path retaining its local bytes and acknowledged base.
   * @param version Verified competing remote generation to retain separately.
   * @returns Attention regardless of whether the excluded copy was verified.
   */
  async conflict(
    entry: SyncDemoEntry,
    version: LiveVersion,
  ): Promise<SyncDemoClientOutcome> {
    const target = {
      revision: version.revision,
      contentSha256: version.contentSha256,
    };
    const next: SyncDemoEntry = {
      ...entry,
      work: { kind: "conflict", target, preserved: false },
    };
    if (!(await this.saveEntry(next))) return "attention";
    await this.local.preserve(entry.path, version.revision, version.content);
    if (
      (await this.local.preserved(entry.path, version.revision)) !==
      version.content
    )
      return "attention";
    await this.saveEntry({
      ...next,
      work: { kind: "conflict", target, preserved: true },
    });
    return "attention";
  }
  /** Rechecks the same competing revision/copy after restart; conflict is latched, not automatic resolution/adoption.
   * @param entry Persisted conflict identity/receipt, not a resolution decision.
   * @returns Visible attention without base/checkpoint advancement.
   */
  async recoverConflict(entry: SyncDemoEntry): Promise<SyncDemoClientOutcome> {
    if (entry.work?.kind !== "conflict") return "attention";
    const version = await this.version(entry.path, entry.work.target);
    if (version === null) return "attention";
    return this.conflict(entry, version);
  }
}
