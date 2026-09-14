import type {
  LocalListResult,
  LocalReadResult,
} from "@core/local-vault/local-vault.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Saved local files only: no mutation, remote access or persistence capabilities.
 * Adapters keep host objects private and use the shared local eligibility policy.
 */
export interface ReadOnlyLocalVault {
  /**
   * Enumerates metadata without reading bodies; the application owns sorting.
   *
   * @returns Eligible entries and one skip count per refused file. Host failure or
   * malformed eligible size metadata returns unavailable, never an empty success.
   */
  list(): Promise<LocalListResult>;

  /**
   * Reads one exact saved file once, without retry, retargeting or editor saving.
   *
   * @param path - Validated literal identity, never URI-decoded or normalized again.
   * @returns Text and measured UTF-8 length only after rechecking eligibility, size
   * and stability. Capture identity/path/mtime/size before awaiting the host read;
   * compare fresh lookup/metadata afterward. Observed changes fail changed-during-read;
   * oversized pre-read metadata avoids buffering and oversized actual text is refused.
   * Metadata checks are best-effort evidence, not an atomic snapshot or write revision.
   */
  read(path: NotePath): Promise<LocalReadResult>;
}
