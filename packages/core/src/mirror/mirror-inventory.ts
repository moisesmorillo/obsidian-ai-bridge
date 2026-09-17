import {
  MAX_REMOTE_INVENTORY_PAGES,
  MIRROR_INVENTORY_INCOMPLETE_REASON,
} from "@core/mirror/mirror-autosync.constants";
import type {
  RemoteBridge,
  RemoteBridgeFailure,
} from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Completed bounded remote inventory used only for diagnostics. */
export interface CompleteMirrorInventory {
  readonly kind: "complete";
  readonly paths: readonly NotePath[];
  readonly pagesRead: number;
}

/** Sanitized incomplete inventory that grants no remote-absence authority. */
export interface IncompleteMirrorInventory {
  readonly kind: "incomplete";
  readonly paths: readonly NotePath[];
  readonly pagesRead: number;
  readonly reason: (typeof MIRROR_INVENTORY_INCOMPLETE_REASON)[keyof typeof MIRROR_INVENTORY_INCOMPLETE_REASON];
  readonly remoteFailure?: RemoteBridgeFailure;
}

/** Result of one finite, non-retrying remote inventory pass. */
export type MirrorInventoryResult =
  | CompleteMirrorInventory
  | IncompleteMirrorInventory;

/**
 * Reads at most the policy page budget and rejects repeated continuation cursors.
 *
 * Partial paths are reporting evidence only. Callers must never subtract local paths
 * from this result to infer a deletion, regardless of completion status.
 *
 * @param remote - Read-only paged remote capability.
 * @returns Sorted unique observed paths and explicit completeness.
 */
export async function inspectBoundedMirrorInventory(
  remote: Pick<RemoteBridge, "listNotes">,
): Promise<MirrorInventoryResult> {
  const paths = new Set<NotePath>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pagesRead = 0;
  while (pagesRead < MAX_REMOTE_INVENTORY_PAGES) {
    const page = await remote.listNotes(cursor);
    if (page.kind === "failure") {
      return {
        kind: "incomplete",
        paths: sortedPaths(paths),
        pagesRead,
        reason: MIRROR_INVENTORY_INCOMPLETE_REASON.remoteFailure,
        remoteFailure: page.failure,
      };
    }
    pagesRead += 1;
    for (const path of page.value.notes) paths.add(path);
    const next = page.value.nextCursor;
    if (next === null) {
      return { kind: "complete", paths: sortedPaths(paths), pagesRead };
    }
    if (cursors.has(next)) {
      return {
        kind: "incomplete",
        paths: sortedPaths(paths),
        pagesRead,
        reason: MIRROR_INVENTORY_INCOMPLETE_REASON.repeatedCursor,
      };
    }
    cursors.add(next);
    cursor = next;
  }
  return {
    kind: "incomplete",
    paths: sortedPaths(paths),
    pagesRead,
    reason: MIRROR_INVENTORY_INCOMPLETE_REASON.pageBudgetExhausted,
  };
}

/**
 * Returns a sorted copy of unique reporting paths without mutating the accumulated inventory.
 *
 * @returns Unique paths in lexical order.
 */
function sortedPaths(paths: ReadonlySet<NotePath>): readonly NotePath[] {
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}
