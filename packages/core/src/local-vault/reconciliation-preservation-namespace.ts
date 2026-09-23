/**
 * Host-visible reserved root used exclusively by newly generated reconciliation artifacts.
 *
 * This protocol-stable vault-relative name is intentionally non-dot-prefixed because
 * real Obsidian 1.13.7 indexing does not expose dot-prefixed folders after creation.
 */
export const RECONCILIATION_PRESERVATION_ROOT = "ai-bridge-conflicts";

/** Historical M4 root retained only for persisted receipt validation and mirror exclusion. */
export const LEGACY_RECONCILIATION_PRESERVATION_ROOT = ".ai-bridge-conflicts";

/** Exact current and historical preservation namespaces, ordered newest first. */
export const RECONCILIATION_PRESERVATION_ROOTS = [
  RECONCILIATION_PRESERVATION_ROOT,
  LEGACY_RECONCILIATION_PRESERVATION_ROOT,
] as const;

/**
 * Tests one exact namespace boundary without prefix overmatching.
 *
 * @param path - Literal vault-relative path or folder name.
 * @param root - Exact reserved root.
 * @returns Whether the path is the root itself or one of its descendants.
 */
function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Excludes both current and historical conflict artifacts from every local mirror path.
 *
 * @param path - Literal vault-relative path or folder name.
 * @returns Whether the path belongs to an exact reserved preservation namespace.
 */
export function isReconciliationPreservationNamespacePath(
  path: string,
): boolean {
  return RECONCILIATION_PRESERVATION_ROOTS.some((root) =>
    isAtOrUnder(path, root),
  );
}

/**
 * Restricts new local effects to the host-visible current preservation namespace.
 *
 * @param path - Generated path proposed for a new preservation effect.
 * @returns Whether the path is exactly the current root or one of its descendants.
 */
export function isCurrentReconciliationPreservationNamespacePath(
  path: string,
): boolean {
  return isAtOrUnder(path, RECONCILIATION_PRESERVATION_ROOT);
}

/**
 * Detects either direction of overlap between the current reserved root and host configuration subtree.
 *
 * @param configDirectory - Exact vault-relative Obsidian configuration directory.
 * @returns Whether either namespace contains the other at a path boundary.
 */
export function currentPreservationNamespaceOverlapsConfig(
  configDirectory: string,
): boolean {
  return (
    isAtOrUnder(RECONCILIATION_PRESERVATION_ROOT, configDirectory) ||
    isAtOrUnder(configDirectory, RECONCILIATION_PRESERVATION_ROOT)
  );
}
