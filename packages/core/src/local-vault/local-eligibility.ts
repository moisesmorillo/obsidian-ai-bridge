import {
  LocalInspectionKind,
  LocalSkipReason,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type {
  LocalEligibilityPolicy,
  LocalNoteEligibility,
  LocalPathEligibility,
  LocalSizeEligibility,
} from "@core/local-vault/local-vault.types";
import { isNormalizedNotePath } from "@core/note-path/note-path";
import { MARKDOWN_FILE_EXTENSION } from "@core/note-path/note-path.constants";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";

/**
 * Applies local privacy/path policy without decoding or repairing literal names.
 *
 * @param path - Untrusted literal vault-relative path, not an encoded identifier.
 * @param policy - Host-supplied configuration-directory exclusion.
 * @returns The unchanged validated path, or the first unsupported/excluded/invalid reason.
 */
export function evaluateLocalNotePath(
  path: string,
  policy: LocalEligibilityPolicy,
): LocalPathEligibility {
  if (!path.endsWith(MARKDOWN_FILE_EXTENSION)) {
    return {
      kind: LocalInspectionKind.failed,
      reason: LocalSkipReason.unsupportedFile,
    };
  }

  if (
    path.split("/").some((segment) => segment.startsWith(".")) ||
    path === policy.configDirectory ||
    path.startsWith(`${policy.configDirectory}/`)
  ) {
    return {
      kind: LocalInspectionKind.failed,
      reason: LocalSkipReason.excludedLocation,
    };
  }

  if (!isNormalizedNotePath(path)) {
    return {
      kind: LocalInspectionKind.failed,
      reason: LocalSkipReason.invalidPath,
    };
  }

  return { kind: LocalInspectionKind.ok, path };
}

/**
 * Enforces the shared byte bound and fails closed for malformed metadata.
 *
 * @param sizeBytes - Host byte-size metadata or measured UTF-8 byte length.
 * @returns Unavailable for negative/fractional/non-finite/unsafe values, oversized
 * for valid integers above the bound, or the accepted size. Exactly the bound is valid.
 */
export function evaluateLocalNoteSize(sizeBytes: number): LocalSizeEligibility {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return {
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    };
  }

  if (sizeBytes > MAX_NOTE_SIZE_BYTES) {
    return {
      kind: LocalInspectionKind.failed,
      reason: LocalSkipReason.oversized,
    };
  }

  return { kind: LocalInspectionKind.ok, sizeBytes };
}

/**
 * Classifies saved-file metadata without reading a body or exposing skipped paths.
 *
 * @param path - Literal candidate path from the host.
 * @param sizeBytes - Untrusted host byte-size metadata.
 * @param policy - The same local exclusions used for active-path inspection.
 * @returns The first unsupported/excluded/invalid/oversized failure, eligible metadata,
 * or unavailable for malformed sizes after path policy succeeds. Enumeration must
 * fail unavailable rather than convert malformed metadata into a skip or empty success.
 */
export function evaluateLocalNote(
  path: string,
  sizeBytes: number,
  policy: LocalEligibilityPolicy,
): LocalNoteEligibility {
  const pathResult = evaluateLocalNotePath(path, policy);
  if (pathResult.kind === LocalInspectionKind.failed) return pathResult;

  const sizeResult = evaluateLocalNoteSize(sizeBytes);
  if (sizeResult.kind === LocalInspectionKind.failed) return sizeResult;

  return {
    kind: LocalInspectionKind.ok,
    entry: { path: pathResult.path, sizeBytes: sizeResult.sizeBytes },
  };
}
