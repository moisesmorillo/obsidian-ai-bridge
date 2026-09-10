import {
  isNormalizedNotePath,
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import { createObsidianVaultHost } from "@obsidian-plugin/infrastructure/obsidian-vault-host";
import type { ObsidianReadOnlyVault } from "@obsidian-plugin/infrastructure/obsidian-vault-host.types";
import { type TAbstractFile, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class {},
  TFolder: class {},
}));

/** Official API subset with observable access and no need to fake the complete App. */
class OfficialVaultFake implements ObsidianReadOnlyVault {
  readonly configDir = "host-settings";
  readonly getFiles = vi.fn((): TFile[] => []);
  readonly getAbstractFileByPath = vi.fn(
    (_path: string): TAbstractFile | null => null,
  );
  readonly read = vi.fn(
    async (_file: TFile): Promise<string> => "saved, not cached",
  );
}

describe("createObsidianVaultHost", () => {
  it("forwards only official saved-file APIs while preserving identity and receiver", async () => {
    const vault = new OfficialVaultFake();
    const file = new TFile();
    file.path = "a%20b.md";
    vault.getFiles.mockImplementation(function (this: OfficialVaultFake) {
      expect(this).toBe(vault);
      return [file];
    });
    vault.getAbstractFileByPath.mockReturnValue(file);
    const host = createObsidianVaultHost(vault);
    expect(host.configDir).toBe("host-settings");
    expect(vault.getFiles).not.toHaveBeenCalled();
    expect(vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(vault.read).not.toHaveBeenCalled();
    expect(host.getFiles()).toEqual([file]);
    expect(host.getFile(file.path)).toBe(file);
    expect(vault.getAbstractFileByPath).toHaveBeenCalledExactlyOnceWith(
      "a%20b.md",
    );
    expect(await host.read(file)).toBe("saved, not cached");
    expect(vault.read).toHaveBeenCalledExactlyOnceWith(file);
  });

  it.each([null, new TFolder()])(
    "does not treat an absent path or folder as a readable file %#",
    async (entry) => {
      const vault = new OfficialVaultFake();
      vault.getAbstractFileByPath.mockReturnValue(entry);
      const path = "folder.md";
      if (!isNormalizedNotePath(path)) throw new Error("Invalid test path");
      expect(
        await new ObsidianLocalVault(createObsidianVaultHost(vault)).read(path),
      ).toEqual({
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.missingFile,
      });
      expect(vault.read).not.toHaveBeenCalled();
    },
  );
});
