import type { LocalEligibilityPolicy } from "@obsidian-ai-bridge/core";
import type { FileStats, TFile, Vault } from "obsidian";

/** Minimal identity-stable file exposed only inside the plugin adapter boundary. */
export interface ObsidianReconciliationFile {
  readonly path: TFile["path"];
  readonly stat: Readonly<Pick<FileStats, "size" | "mtime">>;
}

/** Exact host lookup result distinguishing files from folders without leaking Obsidian to core. */
export type ObsidianReconciliationNode<
  File extends ObsidianReconciliationFile,
> =
  | { readonly kind: "file"; readonly file: File }
  | { readonly kind: "folder" };

/**
 * Minimal official host capabilities required by the local reconciliation writer.
 *
 * Delete, trash, rename, move, generic modify, App, and filesystem capabilities are
 * intentionally absent. The concrete boundary uses only Vault lookup/create/folder/
 * read/process methods supported by the pinned Obsidian baseline.
 */
export interface ObsidianLocalReconciliationHost<
  File extends ObsidianReconciliationFile,
> {
  readonly policy: LocalEligibilityPolicy;
  /** @returns Exact file/folder identity or null without fallback normalization. */
  lookup(path: string): ObsidianReconciliationNode<File> | null;
  /** Creates one plaintext file and rejects host collisions. */
  create(path: string, content: string): Promise<File>;
  /** Creates one exact folder component and rejects host collisions. */
  createFolder(path: string): Promise<void>;
  /** Reads saved plaintext directly from the exact host file. */
  read(file: File): Promise<string>;
  /** Atomically reads, transforms, and writes one exact host file. */
  process(file: File, update: (current: string) => string): Promise<string>;
}

/** Official Vault API subset retained by the Obsidian 1.13.0 plugin minimum. */
export type ObsidianLocalReconciliationVault = Pick<
  Vault,
  | "configDir"
  | "getAbstractFileByPath"
  | "create"
  | "createFolder"
  | "read"
  | "process"
>;
