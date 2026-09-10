import {
  evaluateLocalNote,
  evaluateLocalNotePath,
  evaluateLocalNoteSize,
  type LocalEligibilityPolicy,
  LocalInspectionKind,
  type LocalListResult,
  type LocalNoteEntry,
  type LocalReadResult,
  LocalSkipReason,
  LocalVaultFailureReason,
  type NotePath,
  type ReadOnlyLocalVault,
} from "@obsidian-ai-bridge/core";
import type {
  ObsidianFile,
  ObsidianReadEvidence,
  ObsidianVaultHost,
} from "@obsidian-plugin/infrastructure/obsidian-vault-host.types";

/** Read-only saved-file adapter; host objects and change evidence never escape to core. */
export class ObsidianLocalVault<File extends ObsidianFile>
  implements ReadOnlyLocalVault
{
  /** The host privacy boundary, shared with the application service at composition. */
  readonly policy: LocalEligibilityPolicy;

  /**
   * Captures configuration only; construction never enumerates or reads a file.
   * @param host - Official read-only host boundary or an isolated host double.
   */
  constructor(private readonly host: ObsidianVaultHost<File>) {
    this.policy = { configDirectory: host.configDir };
  }

  /**
   * Enumerates metadata once, without lookup, body access or sorting policy.
   * @returns Eligible entries and closed skip counts, or sanitized unavailable
   * without partial entries if host access or eligible size metadata is invalid.
   */
  async list(): Promise<LocalListResult> {
    try {
      const entries: LocalNoteEntry[] = [];
      const skipped = {
        [LocalSkipReason.unsupportedFile]: 0,
        [LocalSkipReason.excludedLocation]: 0,
        [LocalSkipReason.invalidPath]: 0,
        [LocalSkipReason.oversized]: 0,
      };
      for (const file of this.host.getFiles()) {
        const result = evaluateLocalNote(
          file.path,
          file.stat.size,
          this.policy,
        );
        if (result.kind === LocalInspectionKind.ok) {
          entries.push(result.entry);
          continue;
        }
        if (result.reason === LocalVaultFailureReason.unavailable) {
          return { kind: LocalInspectionKind.failed, reason: result.reason };
        }
        skipped[result.reason] += 1;
      }
      return { kind: LocalInspectionKind.ok, entries, skipped };
    } catch {
      return {
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.unavailable,
      };
    }
  }

  /**
   * Reads one exact saved file with best-effort pre/post identity and stat checks.
   * Indistinguishable timestamps and same-size edits can evade detection;
   * this is not an atomic snapshot, automatic retry or concurrency control for writes.
   *
   * @param path - Validated literal identity, rechecked against local privacy policy.
   * @returns Transient text and measured UTF-8 size only on stable in-limit success.
   * Observed disappearance/replacement/path/mtime/size changes win over post-read
   * payload failures. Host exceptions never carry messages, paths or content out.
   */
  async read(path: NotePath): Promise<LocalReadResult> {
    try {
      const pathResult = evaluateLocalNotePath(path, this.policy);
      if (pathResult.kind === LocalInspectionKind.failed) return pathResult;

      const file = this.host.getFile(path);
      if (file === null) {
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.missingFile,
        };
      }
      const before = this.captureEvidence(file);
      if (before.path !== path) {
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.changedDuringRead,
        };
      }
      const sizeResult = evaluateLocalNoteSize(before.sizeBytes);
      if (sizeResult.kind === LocalInspectionKind.failed) return sizeResult;
      if (!Number.isFinite(before.mtime)) {
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.unavailable,
        };
      }

      const content = await this.host.read(file);
      const current = this.host.getFile(path);
      if (current !== file || !this.matchesEvidence(file, before)) {
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.changedDuringRead,
        };
      }
      const actualSize = evaluateLocalNoteSize(
        new TextEncoder().encode(content).byteLength,
      );
      if (actualSize.kind === LocalInspectionKind.failed) return actualSize;
      return {
        kind: LocalInspectionKind.ok,
        content,
        sizeBytes: actualSize.sizeBytes,
      };
    } catch {
      return {
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.unavailable,
      };
    }
  }

  /**
   * Copies mutable host fields before any await rather than retaining the stat object.
   * @param file - The exact saved-file object returned by the host.
   * @returns Primitive evidence with no host object references.
   */
  private captureEvidence(file: File): ObsidianReadEvidence {
    return {
      path: file.path,
      sizeBytes: file.stat.size,
      mtime: file.stat.mtime,
    };
  }

  /**
   * Equality also preserves prevalidated eligibility and size for the post-read file.
   * @param file - Identity-checked current host object.
   * @param before - Primitive evidence captured before the asynchronous host read.
   * @returns Whether path, size and timestamp are unchanged; not an atomic guarantee.
   */
  private matchesEvidence(file: File, before: ObsidianReadEvidence): boolean {
    const after = this.captureEvidence(file);
    return (
      after.path === before.path &&
      after.sizeBytes === before.sizeBytes &&
      after.mtime === before.mtime
    );
  }
}
