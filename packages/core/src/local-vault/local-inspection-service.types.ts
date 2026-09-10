import type {
  LocalActiveInspectionResult,
  LocalListResult,
} from "@core/local-vault/local-vault.types";

/** Local-only use cases; outputs deliberately cannot carry note bodies. */
export interface LocalInspector {
  /** @returns Eligible metadata in deterministic lexical path order, or a sanitized failure. */
  list(): Promise<LocalListResult>;

  /**
   * Inspects the saved file selected at invocation, not a later active pane.
   *
   * @param path - Captured literal host path, or null when no file was active.
   * @returns Metadata only on success; no-active, policy and runtime failures are typed.
   */
  inspectActivePath(path: string | null): Promise<LocalActiveInspectionResult>;
}
