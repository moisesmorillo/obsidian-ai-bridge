import type { FileStats, TFile, Vault } from "obsidian";

/** Identity-stable host file evidence; no content, editor or mutation capability. */
export interface ObsidianFile {
  /** Literal vault-relative identity, never URI-decoded. */
  readonly path: TFile["path"];
  /** Live host evidence; copy primitives before awaiting a saved-file read. */
  readonly stat: Readonly<Pick<FileStats, "size" | "mtime">>;
}

/**
 * Minimal saved-file host boundary. The generic preserves the concrete file type
 * for Vault.read without casts or exposing full host objects to core.
 */
export interface ObsidianVaultHost<File extends ObsidianFile> {
  /** Exact configured directory supplied by Obsidian, with no trailing separator. */
  readonly configDir: Vault["configDir"];
  /** @returns All saved file objects, including unsupported files for skip counts. */
  getFiles(): readonly File[];
  /**
   * @param path - Exact literal saved-file identity.
   * @returns The file or null for a missing path or folder; never a normalized fallback.
   */
  getFile(path: string): File | null;
  /**
   * @param file - The exact object returned by lookup, not an editor buffer.
   * @returns Saved text from one host read; host failures may reject.
   */
  read(file: File): Promise<string>;
}

/** Official APIs available before the manifest's Obsidian 1.5.0 minimum. */
export type ObsidianReadOnlyVault = Pick<
  Vault,
  "configDir" | "getFiles" | "getAbstractFileByPath" | "read"
>;

/** Primitive evidence only; not a snapshot guarantee, sync version or write precondition. */
export interface ObsidianReadEvidence {
  readonly path: string;
  readonly sizeBytes: number;
  /** Finite Unix timestamp in milliseconds; sub-millisecond and pre-epoch values are valid. */
  readonly mtime: number;
}
