import type {
  ObsidianLocalReconciliationHost,
  ObsidianLocalReconciliationVault,
} from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer.types";
import { TFile, TFolder } from "obsidian";

/**
 * Narrows an official Obsidian Vault to the exact create/process/read capabilities
 * required by the Slice 3 adapter. No delete, rename, trash, move, or raw filesystem
 * capability is retained.
 *
 * @param vault - Official host vault at the pinned minimum version.
 * @returns Minimal mutation host with file/folder collision identity.
 */
export function createObsidianLocalReconciliationHost(
  vault: ObsidianLocalReconciliationVault,
): ObsidianLocalReconciliationHost<TFile> {
  return {
    policy: { configDirectory: vault.configDir },
    lookup: (path) => {
      const node = vault.getAbstractFileByPath(path);
      if (node instanceof TFile) return { kind: "file", file: node };
      if (node instanceof TFolder) return { kind: "folder" };
      return null;
    },
    create: (path, content) => vault.create(path, content),
    createFolder: async (path) => {
      await vault.createFolder(path);
    },
    read: (file) => vault.read(file),
    process: (file, update) => vault.process(file, update),
  };
}
