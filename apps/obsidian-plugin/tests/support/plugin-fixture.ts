import AiBridgePlugin from "@obsidian-plugin/main";
import { host } from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App, type PluginManifest, TFile } from "obsidian";
import { expect, vi } from "vitest";

/** Stable manifest identity; packaging verification belongs to the artifact slice. */
export const manifest: PluginManifest = {
  id: "ai-bridge",
  name: "AI Bridge",
  version: "0.0.0",
  minAppVersion: "1.5.0",
  description: "Local inspection test",
  author: "Test",
  isDesktopOnly: false,
};

/** @returns A real product class using only mocked official host objects. */
export function loadPlugin(): AiBridgePlugin {
  const plugin = new AiBridgePlugin(new App(), manifest);
  plugin.load();
  return plugin;
}

/**
 * Seeds saved-file state directly, not through product mutation APIs.
 * @param path - Literal candidate, including invalid names for refusal tests.
 * @param content - Saved text that must never escape to UI or logging.
 * @param size - Optional misleading byte metadata.
 * @returns The official mocked TFile identity used for active-file capture.
 */
export function addFile(
  path: string,
  content = "PRIVATE BODY",
  size = new TextEncoder().encode(content).byteLength,
): TFile {
  const file = new TFile();
  file.path = path;
  file.stat = { size, mtime: 1000, ctime: 1000 };
  host.files.set(path, file);
  host.contents.set(file, content);
  return file;
}

/**
 * @param id - Unprefixed command ID requested by the test user.
 * @returns The actual registered callback, including asynchronous completion.
 */
export function command(id: string): () => Promise<void> {
  const entry = host.commands.get(`ai-bridge:${id}`);
  if (!entry?.callback) throw new Error("Missing command callback");
  const callback = entry.callback;
  return async () => {
    await callback();
  };
}

/** @returns Visible modal text, preserving exact child insertion order. */
export function modalText(): string[] {
  return [...host.modals].flatMap((modal) =>
    modal.contentEl.children.map((child) => child.textContent),
  );
}

/**
 * Installs observable traps without enabling real network, logging or scheduling.
 * @returns Spies for asserting that no global side effects occurred.
 */
export function sideEffectGuards() {
  const fetch = vi.fn();
  const timer = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("setInterval", timer);
  vi.stubGlobal("setTimeout", timer);
  const logs = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  ];
  return { fetch, timer, logs };
}

/**
 * @param guards - Global traps installed before plugin construction.
 */
export function expectNoSideEffects(
  guards: ReturnType<typeof sideEffectGuards>,
): void {
  for (const spy of [
    guards.fetch,
    guards.timer,
    ...guards.logs,
    host.request,
    host.requestUrl,
    host.loadData,
    host.saveData,
    host.saveEditor,
    host.workspaceOn,
    host.registerInterval,
    host.vault.on,
    host.vault.cachedRead,
    host.vault.create,
    host.vault.modify,
    host.vault.process,
    host.vault.delete,
    host.vault.trash,
    host.vault.rename,
    host.vault.createFolder,
    ...Object.values(host.vault.adapter),
  ])
    expect(spy).not.toHaveBeenCalled();
}
