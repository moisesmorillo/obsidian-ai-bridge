import type { ObsidianLocalReconciliationVault } from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer.types";
import { createObsidianLocalReconciliationHost } from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer-host";
import { type TAbstractFile, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class {},
  TFolder: class {},
}));

/** Official Vault subset fake proving the adapter retains no broader host capability. */
class ReconciliationVaultFake implements ObsidianLocalReconciliationVault {
  readonly configDir = ".obsidian";
  readonly getAbstractFileByPath = vi.fn(
    (_path: string): TAbstractFile | null => null,
  );
  readonly create = vi.fn(
    async (_path: string, _content: string) => new TFile(),
  );
  readonly createFolder = vi.fn(async (_path: string) => new TFolder());
  readonly read = vi.fn(async (_file: TFile) => "saved");
  readonly process = vi.fn(
    async (_file: TFile, update: (current: string) => string) =>
      update("current"),
  );
}

describe("createObsidianLocalReconciliationHost", () => {
  it("maps exact file/folder identity and forwards only official create/process/read APIs", async () => {
    const vault = new ReconciliationVaultFake();
    const file = new TFile();
    file.path = "notes/a.md";
    const folder = new TFolder();
    folder.path = "notes";
    vault.getAbstractFileByPath
      .mockReturnValueOnce(file)
      .mockReturnValueOnce(folder)
      .mockReturnValueOnce(null);
    const host = createObsidianLocalReconciliationHost(vault);
    expect(host.policy).toEqual({ configDirectory: ".obsidian" });
    expect(host.lookup("notes/a.md")).toEqual({ kind: "file", file });
    expect(host.lookup("notes")).toEqual({ kind: "folder" });
    expect(host.lookup("missing")).toBeNull();
    await host.create("notes/new.md", "body");
    await host.createFolder("notes/new");
    await host.read(file);
    await expect(host.process(file, (current) => `${current}!`)).resolves.toBe(
      "current!",
    );
    expect(vault.create).toHaveBeenCalledExactlyOnceWith(
      "notes/new.md",
      "body",
    );
    expect(vault.createFolder).toHaveBeenCalledExactlyOnceWith("notes/new");
    expect(vault.read).toHaveBeenCalledExactlyOnceWith(file);
    expect(vault.process).toHaveBeenCalledWith(file, expect.any(Function));
    expect("delete" in host).toBe(false);
    expect("rename" in host).toBe(false);
    expect("trash" in host).toBe(false);
  });
});
