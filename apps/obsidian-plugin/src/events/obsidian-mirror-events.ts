import {
  evaluateLocalNotePath,
  isNormalizedNotePath,
  isReconciliationPreservationNamespacePath,
  type LocalEligibilityPolicy,
  LocalInspectionKind,
  type MirrorFolderRenameResult,
  type NotePath,
  RECONCILIATION_EVENT_KIND,
  type ReconciliationEventKind,
} from "@obsidian-ai-bridge/core";
import { MAX_QUEUED_OBSERVATION_EVENTS } from "@obsidian-plugin/events/obsidian-mirror-events.constants";
import {
  type EventRef,
  type TAbstractFile,
  TFile,
  TFolder,
  type Vault,
} from "obsidian";

/** Official event registration capability owned by one Plugin enable lifetime. */
export interface ObsidianEventRegistrationHost {
  /** Registers one host event reference for automatic Plugin unload cleanup. */
  registerEvent(event: EventRef): void;
}

/** Primitive lifecycle sink implemented by the same-realm runtime owner. */
export interface MirrorEventSink {
  /** Records immutable eligible saved-file presence. */
  observePresent(path: NotePath, kind?: ReconciliationEventKind): Promise<void>;
  /** Records immutable post-bootstrap deletion evidence. */
  observeDelete(path: NotePath): Promise<void>;
  /** Records immutable file rename identities. */
  observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<void>;
  /** Records a bounded folder transition from pre-event tracked state. */
  observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult | null>;
  /** Revokes event-derived effect authority after an active observation cannot be safely delivered. */
  failObservationDelivery(): Promise<void>;
}

/** One immutable eligible event captured before the runtime dispatch lease is published. */
type QueuedObservation =
  | {
      readonly kind: "present";
      readonly path: NotePath;
      readonly eventKind: ReconciliationEventKind;
    }
  | { readonly kind: "delete"; readonly path: NotePath }
  | {
      readonly kind: "rename";
      readonly sourcePath: NotePath;
      readonly destinationPath: NotePath | null;
    }
  | {
      readonly kind: "folder-rename";
      readonly oldFolder: string;
      readonly newFolder: string | null;
    };

/**
 * Thin official Vault-event adapter that emits immutable primitive observations.
 *
 * Listener registration is delayed until layout readiness. Events racing the durable
 * gap-classification barrier are bounded and serialized before the runtime publishes
 * its effect lease; overflow fails closed rather than dropping observation evidence.
 */
export class ObsidianMirrorEvents {
  private attached = false;
  private accepting = false;
  /** Whether listener setup or observation delivery has made this adapter unusable. */
  private deliveryUnavailable = false;
  private readonly queued: QueuedObservation[] = [];

  /**
   * @param vault - Official Vault event source.
   * @param registration - Plugin-owned event cleanup capability.
   * @param owner - Same-realm runtime coordinator.
   * @param policy - Existing local privacy/eligibility boundary.
   */
  constructor(
    private readonly vault: Vault,
    private readonly registration: ObsidianEventRegistrationHost,
    private readonly owner: MirrorEventSink,
    private readonly policy: LocalEligibilityPolicy,
  ) {}

  /**
   * Attaches every saved-file listener after layout readiness but before lease publication.
   * @returns Whether every listener registered without overflow or registration failure.
   */
  attach(): boolean {
    if (this.deliveryUnavailable) return false;
    if (this.attached) return true;
    this.attached = true;
    try {
      this.registration.registerEvent(
        this.vault.on("create", (file) =>
          this.onPresent(file, RECONCILIATION_EVENT_KIND.create),
        ),
      );
      this.registration.registerEvent(
        this.vault.on("modify", (file) =>
          this.onPresent(file, RECONCILIATION_EVENT_KIND.modify),
        ),
      );
      this.registration.registerEvent(
        this.vault.on("delete", (file) => this.onDelete(file)),
      );
      this.registration.registerEvent(
        this.vault.on("rename", (file, oldPath) =>
          this.onRename(file, oldPath),
        ),
      );
      return !this.deliveryUnavailable;
    } catch {
      this.failDelivery();
      return false;
    }
  }

  /**
   * Persists callbacks captured behind the classification barrier without opening event delivery early.
   * @returns Whether every queued observation committed and the buffer stayed within its bound.
   */
  async drainQueued(): Promise<boolean> {
    if (!this.attached || this.deliveryUnavailable) return false;
    while (this.queued.length > 0) {
      const event = this.queued.shift();
      if (event === undefined) break;
      try {
        await this.dispatch(event);
      } catch {
        this.deliveryUnavailable = true;
        return false;
      }
      if (this.deliveryUnavailable) return false;
    }
    return true;
  }

  /**
   * Opens normal event delivery only after queued evidence was durably sequenced.
   * @returns Whether listeners are active and every earlier event was drained.
   */
  activate(): boolean {
    if (
      !this.attached ||
      this.deliveryUnavailable ||
      this.queued.length !== 0
    ) {
      return false;
    }
    this.accepting = true;
    return true;
  }

  /** Prevents stale callbacks from admitting new observations after unload. */
  detach(): void {
    this.attached = false;
    this.accepting = false;
    this.queued.length = 0;
  }

  /** Captures eligible saved-file presence only while attached; pre-lease observations stay behind the barrier. */
  private onPresent(
    file: TAbstractFile,
    eventKind: ReconciliationEventKind,
  ): void {
    if (!this.attached || !(file instanceof TFile)) return;
    const path = eligiblePath(file.path, this.policy);
    if (path === null) return;
    this.submit({ kind: "present", path, eventKind });
  }

  /** Emits file absence or folder-removal observations without inventing deletion authority. */
  private onDelete(file: TAbstractFile): void {
    if (!this.attached) return;
    if (file instanceof TFile) {
      const path = eligiblePath(file.path, this.policy);
      if (path !== null) this.submit({ kind: "delete", path });
      return;
    }
    if (file instanceof TFolder) {
      const oldFolder = `${file.path}`;
      if (eligibleFolder(oldFolder, this.policy)) {
        this.submit({ kind: "folder-rename", oldFolder, newFolder: null });
      }
    }
  }

  /**
   * Captures old/new identities and maps scope entry/exit without reading note bodies.
   * @param file - Current official host file or folder identity.
   * @param oldPathValue - Host-supplied pre-rename path.
   * @returns Nothing; eligible observations are buffered or delivered to the owner.
   */
  private onRename(file: TAbstractFile, oldPathValue: string): void {
    if (!this.attached) return;
    const oldPath = `${oldPathValue}`;
    const newPath = `${file.path}`;
    if (file instanceof TFile) {
      if (isReconciliationPreservationNamespacePath(oldPath)) return;
      const sourcePath = eligiblePath(oldPath, this.policy);
      const destinationPath = eligiblePath(newPath, this.policy);
      if (sourcePath !== null) {
        this.submit({ kind: "rename", sourcePath, destinationPath });
        return;
      }
      if (destinationPath !== null) {
        this.submit({
          kind: "present",
          path: destinationPath,
          eventKind: RECONCILIATION_EVENT_KIND.modify,
        });
      }
      return;
    }
    if (file instanceof TFolder && eligibleFolder(oldPath, this.policy)) {
      const newFolder = eligibleFolder(newPath, this.policy) ? newPath : null;
      this.submit({ kind: "folder-rename", oldFolder: oldPath, newFolder });
    }
  }

  /** Delivers a post-barrier event or retains it for serialized startup processing. */
  private submit(event: QueuedObservation): void {
    if (!this.accepting) {
      if (this.queued.length >= MAX_QUEUED_OBSERVATION_EVENTS) {
        this.failDelivery();
        return;
      }
      this.queued.push(event);
      return;
    }
    void this.dispatch(event).catch(() => this.failDelivery());
  }

  /** Synchronously halts event delivery and requests durable runtime fencing after setup or sink failure. */
  private failDelivery(): void {
    if (this.deliveryUnavailable) return;
    this.deliveryUnavailable = true;
    this.detach();
    void this.owner.failObservationDelivery().catch(() => undefined);
  }

  /** Sends one already-normalized immutable observation to its primitive runtime sink. */
  private async dispatch(event: QueuedObservation): Promise<void> {
    switch (event.kind) {
      case "present":
        await this.owner.observePresent(event.path, event.eventKind);
        return;
      case "delete":
        await this.owner.observeDelete(event.path);
        return;
      case "rename":
        await this.owner.observeRename(event.sourcePath, event.destinationPath);
        return;
      case "folder-rename":
        await this.owner.observeFolderRename(event.oldFolder, event.newFolder);
        return;
    }
  }
}

/**
 * Rejects nonliteral or privacy-excluded event paths without repair or URI-decoding.
 *
 * @param value - Untrusted host event path.
 * @param policy - Current vault privacy exclusions.
 * @returns The eligible literal path, or null.
 */
function eligiblePath(
  value: string,
  policy: LocalEligibilityPolicy,
): NotePath | null {
  if (!isNormalizedNotePath(value)) return null;
  const result = evaluateLocalNotePath(value, policy);
  return result.kind === LocalInspectionKind.ok ? result.path : null;
}

/**
 * Tests folder scope through a hypothetical Markdown descendant using shared path/privacy policy.
 *
 * @param folder - Literal host folder path.
 * @param policy - Current vault privacy exclusions.
 * @returns Whether a Markdown child would be eligible.
 */
function eligibleFolder(
  folder: string,
  policy: LocalEligibilityPolicy,
): boolean {
  if (folder.length === 0 || folder.endsWith("/")) return false;
  return eligiblePath(`${folder}/placeholder.md`, policy) !== null;
}
