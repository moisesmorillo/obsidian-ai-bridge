import type {
  LocalInspectionKind,
  LocalSkipReason,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Host-supplied local privacy policy, shared by the service and adapter. */
export interface LocalEligibilityPolicy {
  /** Exact vault-relative configuration directory, with no trailing separator. */
  readonly configDirectory: string;
}

/** One deterministic reason for skipping a file without reading its body. */
export type LocalSkipReasonCode =
  (typeof LocalSkipReason)[keyof typeof LocalSkipReason];

/** Closed expected failures, never raw runtime error messages. */
export type LocalVaultFailureReasonCode =
  (typeof LocalVaultFailureReason)[keyof typeof LocalVaultFailureReason];

/** A sanitized failure with no path, body or host exception. */
export interface LocalFailure<Reason extends LocalVaultFailureReasonCode> {
  readonly kind: typeof LocalInspectionKind.failed;
  readonly reason: Reason;
}

/** Failures that can be determined from the literal path alone. */
export type LocalPathFailureReason = Exclude<
  LocalSkipReasonCode,
  typeof LocalSkipReason.oversized
>;

/** Literal path validation either narrows identity unchanged or refuses access. */
export type LocalPathEligibility =
  | { readonly kind: typeof LocalInspectionKind.ok; readonly path: NotePath }
  | LocalFailure<LocalPathFailureReason>;

/** Invalid metadata fails unavailable; a valid size above the bound is oversized. */
export type LocalSizeEligibility =
  | { readonly kind: typeof LocalInspectionKind.ok; readonly sizeBytes: number }
  | LocalFailure<
      | typeof LocalSkipReason.oversized
      | typeof LocalVaultFailureReason.unavailable
    >;

/** Ephemeral saved-file metadata, not an atomic snapshot or durable sync revision. */
export interface LocalNoteEntry {
  readonly path: NotePath;
  /** Nonnegative safe integer, no greater than the shared note byte limit. */
  readonly sizeBytes: number;
}

/** Combined path/metadata policy; unavailable is not an enumeration skip reason. */
export type LocalNoteEligibility =
  | {
      readonly kind: typeof LocalInspectionKind.ok;
      readonly entry: LocalNoteEntry;
    }
  | LocalFailure<
      LocalSkipReasonCode | typeof LocalVaultFailureReason.unavailable
    >;

/** Counts for every skip reason; one file contributes to at most one count. */
export type LocalSkippedCounts = {
  readonly [Reason in LocalSkipReasonCode]: number;
};

/** Enumeration returns only eligible metadata, or fails without a partial list. */
export type LocalListResult =
  | {
      readonly kind: typeof LocalInspectionKind.ok;
      readonly entries: readonly LocalNoteEntry[];
      readonly skipped: LocalSkippedCounts;
    }
  | LocalFailure<typeof LocalVaultFailureReason.unavailable>;

/** A captured-path read cannot itself fail for lack of an active editor. */
export type LocalReadFailureReason = Exclude<
  LocalVaultFailureReasonCode,
  typeof LocalVaultFailureReason.noActiveFile
>;

/**
 * Transient saved text returned only after adapter size and change checks succeed.
 * The service discards content and does not expose it to inspection UI callers.
 */
export type LocalReadResult =
  | {
      readonly kind: typeof LocalInspectionKind.ok;
      readonly content: string;
      /** Actual UTF-8 byte length, not JavaScript string length or host stat size. */
      readonly sizeBytes: number;
    }
  | LocalFailure<LocalReadFailureReason>;

/** Metadata-only outcome of inspecting a captured active path (or no active file). */
export type LocalActiveInspectionResult =
  | {
      readonly kind: typeof LocalInspectionKind.ok;
      readonly entry: LocalNoteEntry;
    }
  | LocalFailure<LocalVaultFailureReasonCode>;
