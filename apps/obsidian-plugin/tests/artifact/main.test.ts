import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import manifest from "@obsidian-plugin-manifest";
import * as obsidian from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App, TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

/** Reads generated files only; no source entry import or real vault is involved. */
const bundle = readFileSync(
  new URL("../../dist/main.js", import.meta.url),
  "utf8",
);
const manifestText = readFileSync(
  new URL("../../dist/manifest.json", import.meta.url),
  "utf8",
);

/**
 * Executes CommonJS in a host-like realm with no Node globals or module resolution.
 * The external module boundary is checked before its default class is constructed.
 * @returns The actual bundled plugin instance using only an in-memory host double.
 */
function loadArtifact(): obsidian.Plugin {
  const module: { exports: unknown } = { exports: {} };
  const required: string[] = [];
  new Script(bundle, { filename: "ai-bridge/main.js" }).runInNewContext({
    module,
    exports: module.exports,
    TextEncoder,
    require: (name: string) => {
      expect(name).toBe("obsidian");
      required.push(name);
      return obsidian;
    },
  });
  expect(required.length).toBeGreaterThan(0);
  const namespace = module.exports;
  if (
    typeof namespace !== "object" ||
    namespace === null ||
    !("default" in namespace)
  ) {
    throw new Error("Expected a CommonJS default export namespace");
  }
  const pluginClass = namespace.default;
  if (
    typeof pluginClass !== "function" ||
    !(pluginClass.prototype instanceof obsidian.Plugin)
  ) {
    throw new Error("Expected the default export to extend the host Plugin");
  }
  expect(JSON.parse(manifestText)).toEqual(manifest);
  const plugin: unknown = Reflect.construct(pluginClass, [new App(), manifest]);
  if (!(plugin instanceof obsidian.Plugin))
    throw new Error("Expected a host Plugin instance");
  plugin.load();
  return plugin;
}

/**
 * @param id - Host-qualified command identity from the packaged plugin.
 * @returns The registered callback, failing immediately if packaging lost a command.
 */
function command(id: string): () => Promise<void> {
  const callback = obsidian.host.commands.get(id)?.callback;
  if (!callback) throw new Error("Expected a registered command callback");
  return async () => {
    await callback();
  };
}

beforeEach(obsidian.resetHost);

describe("packaged Obsidian main.js", () => {
  it("stages the unchanged manifest beside a CommonJS bundle with only obsidian external", () => {
    expect(manifestText).toBe(
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
    );
    expect(JSON.parse(manifestText)).toMatchObject({
      id: "ai-bridge",
      minAppVersion: "1.5.0",
      isDesktopOnly: false,
    });
    const requires = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    expect(requires.length).toBeGreaterThan(0);
    expect(new Set(requires)).toEqual(new Set(["obsidian"]));
    expect(bundle).not.toMatch(
      /\b(?:process|Buffer|Bun|__dirname|__filename)\b|node:|import\s*\(/,
    );
  });

  it("loads inertly, invokes both bundled commands, and disposes host registrations and metadata UI", async () => {
    const plugin = loadArtifact();
    expect(
      [...obsidian.host.commands].map(([id, entry]) => [id, entry.name]),
    ).toEqual([
      ["ai-bridge:inspect-local-notes", "Inspect local Markdown notes"],
      ["ai-bridge:inspect-active-note", "Inspect active Markdown note"],
    ]);
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    expect(obsidian.host.getActiveFile).not.toHaveBeenCalled();
    expect(obsidian.host.loadData).not.toHaveBeenCalled();
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
    expect(obsidian.host.modals.size).toBe(0);
    expect(obsidian.host.notices).toEqual([]);

    const file = new TFile();
    file.path = "100% 雪.md";
    file.stat = { size: 3, mtime: 1000, ctime: 1000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.contents.set(file, "雪");
    obsidian.host.active = file;
    await command("ai-bridge:inspect-local-notes")();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    const [modal] = [...obsidian.host.modals];
    if (!modal) throw new Error("Expected a visible metadata modal");
    expect(
      modal.contentEl.children.map((child) => child.textContent),
    ).toContain("100% 雪.md — 3 bytes");
    await command("ai-bridge:inspect-active-note")();
    expect(obsidian.host.vault.read).toHaveBeenCalledExactlyOnceWith(file);
    expect(obsidian.host.notices.at(-1)?.message).toBe(
      "Saved note: 100% 雪.md\nUTF-8 bytes: 3\nSaved vault text only. Save and retry to include unsaved changes.",
    );
    plugin.unload();
    expect(obsidian.host.commands.size).toBe(0);
    expect(obsidian.host.modals.size).toBe(0);
    expect(modal.contentEl.children).toEqual([]);
    expect(obsidian.host.notices.every((notice) => notice.hidden)).toBe(true);
    expect(obsidian.host.contents.get(file)).toBe("雪");
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
    plugin.load();
    expect(obsidian.host.commands.size).toBe(2);
    plugin.unload();
    expect(obsidian.host.commands.size).toBe(0);
  });

  it("suppresses late UI from an in-flight bundled command after unload", async () => {
    const plugin = loadArtifact();
    const file = new TFile();
    file.path = "active.md";
    file.stat = { size: 0, mtime: 1000, ctime: 1000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.active = file;
    const pending = Promise.withResolvers<string>();
    obsidian.host.vault.read.mockReturnValue(pending.promise);
    const inspect = command("ai-bridge:inspect-active-note");
    const work = inspect();
    plugin.unload();
    pending.resolve("");
    await work;
    await inspect();
    expect(obsidian.host.notices).toEqual([]);
    expect(obsidian.host.commands.size).toBe(0);
    expect(obsidian.host.vault.read).toHaveBeenCalledTimes(1);
  });
});
