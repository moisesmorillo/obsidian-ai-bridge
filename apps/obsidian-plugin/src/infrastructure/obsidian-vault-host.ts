import type {
  ObsidianReadOnlyVault,
  ObsidianVaultHost,
} from "@obsidian-plugin/infrastructure/obsidian-vault-host.types";
import { TFile } from "obsidian";

/**
 * Restricts official host APIs to saved-file access without retaining the App.
 *
 * Uses getAbstractFileByPath (since 0.11.11), not getFileByPath (1.5.7),
 * to honor minAppVersion 1.5.0. Vault.read deliberately bypasses cached/editor text.
 *
 * @param vault - The host's vault, narrowed to read-only capabilities.
 * @returns A host boundary preserving TFile identity for lookup/read comparisons.
 */
export function createObsidianVaultHost(
  vault: ObsidianReadOnlyVault,
): ObsidianVaultHost<TFile> {
  return {
    configDir: vault.configDir,
    getFiles: () => vault.getFiles(),
    getFile: (path) => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? file : null;
    },
    read: (file) => vault.read(file),
  };
}
