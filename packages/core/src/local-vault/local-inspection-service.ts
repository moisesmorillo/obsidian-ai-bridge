import { evaluateLocalNotePath } from "@core/local-vault/local-eligibility";
import type { LocalInspector } from "@core/local-vault/local-inspection-service.types";
import {
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type {
  LocalActiveInspectionResult,
  LocalEligibilityPolicy,
  LocalListResult,
} from "@core/local-vault/local-vault.types";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";

/** Coordinates read-only local inspection and prevents content from escaping to UI callers. */
export class LocalInspectionService implements LocalInspector {
  /**
   * @param vault - Read-only adapter responsible for saved-file access and race checks.
   * @param policy - Host configuration-directory policy also used by the adapter.
   */
  constructor(
    private readonly vault: ReadOnlyLocalVault,
    private readonly policy: LocalEligibilityPolicy,
  ) {}

  /**
   * Enumerates once, without body reads or mutation of the adapter's result array.
   *
   * @returns A lexical (not locale-dependent) metadata list or sanitized unavailable failure.
   */
  async list(): Promise<LocalListResult> {
    try {
      const result = await this.vault.list();
      if (result.kind === LocalInspectionKind.failed) return result;

      return {
        kind: LocalInspectionKind.ok,
        entries: [...result.entries].sort((left, right) => {
          if (left.path === right.path) return 0;
          return left.path < right.path ? -1 : 1;
        }),
        skipped: result.skipped,
      };
    } catch {
      return {
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.unavailable,
      };
    }
  }

  /**
   * Validates the captured literal path before a single saved-file read.
   *
   * @param path - Exact host path at invocation, or null when no file was active.
   * @returns Only path and actual UTF-8 byte count on success; failures never carry
   * raw exceptions or bodies. There is no retry, persisted evidence or retained text.
   */
  async inspectActivePath(
    path: string | null,
  ): Promise<LocalActiveInspectionResult> {
    if (path === null) {
      return {
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.noActiveFile,
      };
    }

    const eligibility = evaluateLocalNotePath(path, this.policy);
    if (eligibility.kind === LocalInspectionKind.failed) return eligibility;

    try {
      const result = await this.vault.read(eligibility.path);
      if (result.kind === LocalInspectionKind.failed) return result;

      return {
        kind: LocalInspectionKind.ok,
        entry: { path: eligibility.path, sizeBytes: result.sizeBytes },
      };
    } catch {
      return {
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.unavailable,
      };
    }
  }
}
