import type {
  SyncNotePath,
  SyncRevision,
  SyncVaultId,
} from "@core/sync/sync.types";
import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncMutationRequest,
  SyncMutationResult,
  SyncReadChangesResult,
  SyncReadCurrentResult,
  SyncReadVersionResult,
  SyncStoreFailure,
} from "@core/sync/sync-store.types";

/** Admits only the explicit synthetic path set without changing SyncStore authority. */
export class SyncDemoService {
  /** Binds one isolated vault and its byte limit; preparation may create only its marker after mutation admission.
   * @param store Existing exact-parent revision authority.
   * @param vaultId Immutable server-configured lab identity.
   * @param paths Explicit synthetic paths admitted by this service.
   * @param maxContentBytes UTF-8 payload admission ceiling.
   * @param prepareMutation Marker-only preparation after policy admission; reads never call it.
   */
  constructor(
    private readonly store: SyncStore,
    private readonly vaultId: SyncVaultId,
    private readonly paths: readonly SyncNotePath[],
    private readonly maxContentBytes: number,
    private readonly prepareMutation: () => Promise<SyncStoreFailure | null>,
  ) {}

  /** Reads only an admitted-size head; missing namespaces remain typed failures, not empty vaults.
   * @param path Validated canonical path to observe.
   * @returns Exact head evidence or typed refusal/unavailability.
   */
  async readCurrent(path: SyncNotePath): Promise<SyncReadCurrentResult> {
    if (!this.paths.includes(path))
      return { kind: "error", code: "invalid_input" };
    const result = await this.store.readCurrent({
      vaultId: this.vaultId,
      path,
    });
    if (result.kind === "error" || result.kind === "never_seen") return result;
    if (result.byteSize > this.maxContentBytes)
      return { kind: "error", code: "invalid_input" };
    return result;
  }

  /** Returns immutable bytes only when their validated version belongs to the admitted path and byte scope.
   * @param revision Exact immutable revision, never a storage ETag.
   * @returns Verified immutable version or explicit absence/failure.
   */
  async readVersion(revision: SyncRevision): Promise<SyncReadVersionResult> {
    const result = await this.store.readVersion({
      vaultId: this.vaultId,
      revision,
    });
    if (
      result.kind === "present" &&
      (!this.paths.includes(result.version.path) ||
        result.version.byteSize > this.maxContentBytes)
    ) {
      return { kind: "error", code: "invalid_input" };
    }
    return result;
  }

  /** Replays the identical full request through the store; never refreshes its parent or accepts a tombstone.
   * @param request Full operation identity and bytes with server-bound vault/origin.
   * @returns Verified committed result or original typed non-success certainty.
   */
  async mutate(request: SyncMutationRequest): Promise<SyncMutationResult> {
    if (
      request.kind === "tombstone" ||
      request.vaultId !== this.vaultId ||
      !this.paths.includes(request.path) ||
      new TextEncoder().encode(request.content).byteLength >
        this.maxContentBytes
    )
      return { kind: "error", code: "invalid_input" };
    const failure = await this.prepareMutation();
    if (failure !== null) return failure;
    return this.store.mutate(request);
  }

  /** Returns the original bounded checkpoint page only if every changed path is admitted.
   * @param cursor Original vault-bound opaque checkpoint; invalid cursors are not repaired.
   * @returns Unmodified bounded page or typed failure without cursor advancement.
   */
  async readChanges(cursor: string): Promise<SyncReadChangesResult> {
    const result = await this.store.readChanges({
      vaultId: this.vaultId,
      cursor,
    });
    if (
      result.kind === "page" &&
      result.events.some(
        (event) => event.kind === "changed" && !this.paths.includes(event.path),
      )
    ) {
      return { kind: "error", code: "invalid_input" };
    }
    return result;
  }
}
