import {
  syncNotePathSchema,
  syncRevisionSchema,
} from "@obsidian-ai-bridge/protocol";
import { DemoLocal } from "@obsidian-plugin/demo/demo-local";
import { type TAbstractFile, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);
const path = syncNotePathSchema.parse("demo.md");
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
function fixture() {
  const nodes = new Map<string, TAbstractFile>();
  const contents = new Map<TFile, string>();
  let active = true;
  let race = () => {};
  const vault = {
    configDir: "config",
    getAllLoadedFiles: () => [...nodes.values()],
    getAbstractFileByPath: (name: string) => nodes.get(name) ?? null,
    read: vi.fn(async (file: TFile) => contents.get(file) ?? ""),
    create: vi.fn(async (name: string, text: string) => {
      if (nodes.has(name)) throw new Error("Collision");
      const file = Object.assign(new TFile(), { path: name });
      nodes.set(name, file);
      contents.set(file, text);
      return file;
    }),
    createFolder: vi.fn(async (name: string) => {
      const folder = Object.assign(new TFolder(), { path: name });
      nodes.set(name, folder);
      return folder;
    }),
    process: vi.fn(async (file: TFile, update: (text: string) => string) => {
      race();
      const text = update(contents.get(file) ?? "");
      contents.set(file, text);
      return text;
    }),
  };
  return {
    nodes,
    contents,
    vault,
    local: new DemoLocal(vault, () => active),
    detach: () => {
      active = false;
    },
    setRace: (callback: () => void) => {
      race = callback;
    },
  };
}
describe("official demo local admission", () => {
  it("creates only absent targets and replaces exact saved bytes through process", async () => {
    const f = fixture();
    expect(await f.local.observe(path)).toEqual({ kind: "absent" });
    expect(await f.local.apply(path, null, "original\r\n")).toBe("applied");
    expect(await f.local.apply(path, null, "other")).toBe("refused");
    expect(await f.local.apply(path, "original\r\n", "next")).toBe("applied");
    expect(f.vault.process).toHaveBeenCalledTimes(1);
    expect(await f.local.observe(path)).toEqual({
      kind: "live",
      content: "next",
    });
  });
  it.each(["edit", "alias", "detach"] as const)(
    "refuses %s inside process without losing bytes",
    async (kind) => {
      const f = fixture();
      await f.vault.create(path, "base");
      f.setRace(() => {
        if (kind === "edit")
          for (const file of f.contents.keys())
            f.contents.set(file, "local edit");
        if (kind === "alias")
          f.nodes.set(
            "DEMO.md",
            Object.assign(new TFile(), { path: "DEMO.md" }),
          );
        if (kind === "detach") f.detach();
      });
      expect(await f.local.apply(path, "base", "remote")).toBe("refused");
      expect([...f.contents.values()]).toEqual([
        kind === "edit" ? "local edit" : "base",
      ]);
    },
  );
  it.each(["alias", "folder", "config", "oversize"] as const)(
    "blocks %s before effects",
    async (kind) => {
      const f = fixture();
      if (kind === "alias")
        f.nodes.set("DEMO.md", Object.assign(new TFile(), { path: "DEMO.md" }));
      if (kind === "folder")
        f.nodes.set(path, Object.assign(new TFolder(), { path }));
      if (kind === "oversize") await f.vault.create(path, "x".repeat(16_385));
      const target =
        kind === "config" ? syncNotePathSchema.parse("config/note.md") : path;
      expect(await f.local.observe(target)).toEqual({ kind: "blocked" });
    },
  );
  it("blocks ancestor aliases and unavailable reads and retains dispatched write uncertainty", async () => {
    const f = fixture();
    const nested = syncNotePathSchema.parse("sub/demo.md");
    f.nodes.set("SUB", Object.assign(new TFolder(), { path: "SUB" }));
    expect(await f.local.observe(nested)).toEqual({ kind: "blocked" });
    f.nodes.clear();
    const file = await f.vault.create(path, "base");
    f.vault.read.mockRejectedValueOnce(new Error("Unavailable"));
    expect(await f.local.observe(path)).toEqual({ kind: "blocked" });
    f.vault.process.mockRejectedValueOnce(new Error("Uncertain"));
    expect(await f.local.apply(path, "base", "next")).toBe("unknown");
    expect(f.contents.get(file)).toBe("base");
    expect(await f.local.preserved(path, revision)).toBeNull();
    f.detach();
    expect(await f.local.preserved(path, revision)).toBeNull();
    await expect(f.local.preserve(path, revision, "next")).rejects.toThrow();
  });
  it("preserves a deterministic excluded copy and refuses a competing collision", async () => {
    const f = fixture();
    await f.local.preserve(path, revision, "remote");
    expect(await f.local.preserved(path, revision)).toBe("remote");
    await f.local.preserve(path, revision, "remote");
    await expect(
      f.local.preserve(path, revision, "different"),
    ).rejects.toThrow();
    expect(await f.local.preserved(path, revision)).toBe("remote");
    expect(f.vault.create).toHaveBeenCalledTimes(1);
    f.detach();
    expect(await f.local.apply(path, null, "no")).toBe("refused");
  });
});
