import {
  evaluateLocalNotePath,
  isNormalizedNotePath,
  isReconciliationPreservationNamespacePath,
  type LocalEligibilityPolicy,
  LocalInspectionKind,
  type NotePath,
  RECONCILIATION_EVENT_KIND,
  type ReconciliationEventKind,
} from "@obsidian-ai-bridge/core";
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
  ): Promise<unknown>;
}

/**
 * Thin official Vault-event adapter that emits immutable primitive observations.
 *
 * It subscribes only to saved-file lifecycle events. No editor event, Fetch policy,
 * DTO mapping, body read, or persistence decision exists in this adapter.
 */
export class ObsidianMirrorEvents {
  private attached = false;

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

  /** Registers create/modify/delete/rename before layout-ready bootstrap begins. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
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
      this.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
  }

  /** Prevents stale callbacks from admitting new observations after unload. */
  detach(): void {
    this.attached = false;
  }

  /** Captures eligible saved-file presence only while attached; delegates authority and failure handling to the owner. */
  private onPresent(file: TAbstractFile, kind: ReconciliationEventKind): void {
    if (!this.attached || !(file instanceof TFile)) return;
    const path = eligiblePath(file.path, this.policy);
    if (path === null) return;
    void this.owner.observePresent(path, kind).catch(() => undefined);
  }

  /** Emits file absence or folder-removal observations; the core decides whether post-bootstrap deletion authority exists. */
  private onDelete(file: TAbstractFile): void {
    if (!this.attached) return;
    if (file instanceof TFile) {
      const path = eligiblePath(file.path, this.policy);
      if (path !== null) {
        void this.owner.observeDelete(path).catch(() => undefined);
      }
      return;
    }
    if (file instanceof TFolder) {
      const oldFolder = `${file.path}`;
      if (!eligibleFolder(oldFolder, this.policy)) return;
      void this.owner
        .observeFolderRename(oldFolder, null)
        .catch(() => undefined);
    }
  }

  /** Captures old/new identities and maps scope entry to presence, scope exit to null destination, without reading bodies. */
  private onRename(file: TAbstractFile, oldPathValue: string): void {
    if (!this.attached) return;
    const oldPath = `${oldPathValue}`;
    const newPath = `${file.path}`;
    if (file instanceof TFile) {
      if (isReconciliationPreservationNamespacePath(oldPath)) return;
      const source = eligiblePath(oldPath, this.policy);
      const destination = eligiblePath(newPath, this.policy);
      if (source !== null) {
        void this.owner
          .observeRename(source, destination)
          .catch(() => undefined);
        return;
      }
      if (destination !== null) {
        void this.owner.observePresent(destination).catch(() => undefined);
      }
      return;
    }
    if (file instanceof TFolder) {
      if (!eligibleFolder(oldPath, this.policy)) return;
      const destinationFolder = eligibleFolder(newPath, this.policy)
        ? newPath
        : null;
      void this.owner
        .observeFolderRename(oldPath, destinationFolder)
        .catch(() => undefined);
    }
  }
}

/**
 * Rejects nonliteral or privacy-excluded event paths without repairing or URI-decoding them.
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
 * Tests folder scope through a hypothetical Markdown descendant using the shared path/privacy policy.
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
