import {
  isNormalizedNotePath,
  LocalInspectionKind,
  LocalInspectionService,
  type LocalListResult,
  LocalVaultFailureReason,
} from "@obsidian-ai-bridge/core";
import AiBridgePlugin from "@obsidian-plugin/main";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  addFile,
  command,
  expectNoSideEffects,
  loadPlugin,
  loadPluginReady,
  manifest,
  modalText,
  sideEffectGuards,
} from "@obsidian-plugin-tests/support/plugin-fixture";
import { App, Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

const emptyList: LocalListResult = {
  kind: LocalInspectionKind.ok,
  entries: [],
  skipped: {
    unsupported_file: 0,
    excluded_location: 0,
    invalid_path: 0,
    oversized: 0,
  },
};

beforeEach(resetHost);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AiBridgePlugin commands and lifecycle", () => {
  it("composes unconfigured M3 UI/events before layout while preserving passive behavior and M2 commands", async () => {
    const guards = sideEffectGuards();
    const plugin = await loadPluginReady();
    expect([...host.commands.keys()]).toEqual([
      "ai-bridge:inspect-local-notes",
      "ai-bridge:inspect-active-note",
      "ai-bridge:show-mirror-status",
      "ai-bridge:check-mirror-now",
      "ai-bridge:retry-mirror-failures",
      "ai-bridge:pause-mirror",
      "ai-bridge:resume-mirror",
      "ai-bridge:prepare-writer-handoff",
      "ai-bridge:review-remote-divergence",
      "ai-bridge:restore-recovery-snapshot",
    ]);
    expect(host.settingsTabs.size).toBe(1);
    expect(host.statusBars.size).toBe(1);
    expect(host.vault.on.mock.calls.map(([name]) => name)).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
    ]);
    expect(host.vault.on.mock.invocationCallOrder.at(-1)).toBeLessThan(
      host.onLayoutReady.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    host.becomeLayoutReady();
    await Promise.resolve();
    expect(host.vault.getFiles).not.toHaveBeenCalled();
    expect(guards.fetch).not.toHaveBeenCalled();
    await command("inspect-local-notes")();
    expect(host.vault.getFiles).toHaveBeenCalledOnce();
    plugin.unload();
    expect(host.commands.size).toBe(0);
    expect(host.settingsTabs.size).toBe(0);
    expect(host.statusBars.size).toBe(0);
    expect(
      [...host.vaultListeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
  });

  it("suppresses late M3 composition after unload during initial data loading", async () => {
    const pending = Promise.withResolvers<unknown>();
    host.loadData.mockReturnValueOnce(pending.promise);
    const plugin = new AiBridgePlugin(new App(), manifest);
    const startLoad = () => plugin.load();
    const loading = Promise.resolve(startLoad());
    plugin.unload();
    pending.resolve(null);
    await loading;
    expect(host.settingsTabs.size).toBe(0);
    expect([...host.commands.keys()]).toEqual([]);
  });

  it("keeps the runtime available when the optional status bar host fails", async () => {
    vi.spyOn(Plugin.prototype, "addStatusBarItem").mockImplementationOnce(
      () => {
        throw new Error("expected");
      },
    );
    const plugin = await loadPluginReady();
    expect(host.statusBars.size).toBe(0);
    expect(host.settingsTabs.size).toBe(1);
    await command("show-mirror-status")();
    expect(modalText().join("\n")).toContain("Configuration: unconfigured");
    plugin.unload();
  });

  it("reloads external configuration through the same fail-closed boundary", async () => {
    const plugin = await loadPluginReady();
    host.loadData.mockResolvedValueOnce({ schemaVersion: 99 });
    plugin.onExternalSettingsChange();
    await vi.waitFor(() => expect(host.loadData).toHaveBeenCalledTimes(2));
    await command("show-mirror-status")();
    expect(modalText().join("\n")).toContain("Configuration: invalid");
    plugin.unload();
    plugin.onExternalSettingsChange();
    expect(host.loadData).toHaveBeenCalledTimes(2);
  });

  it("registers exactly two M2 commands synchronously, stays inert, and lets the host dispose registrations", () => {
    const guards = sideEffectGuards();
    const list = vi.spyOn(LocalInspectionService.prototype, "list");
    const read = vi.spyOn(
      LocalInspectionService.prototype,
      "inspectActivePath",
    );
    const plugin = loadPlugin();
    expect(
      [...host.commands.values()].map(({ id, name }) => ({ id, name })),
    ).toEqual([
      {
        id: "ai-bridge:inspect-local-notes",
        name: "Inspect local Markdown notes",
      },
      {
        id: "ai-bridge:inspect-active-note",
        name: "Inspect active Markdown note",
      },
    ]);
    plugin.load();
    expect(host.commands.size).toBe(2);
    const unrelated = { id: "other:command", name: "Another plugin's command" };
    host.commands.set(unrelated.id, unrelated);
    plugin.unload();
    expect([...host.commands.values()]).toEqual([unrelated]);
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(host.getActiveFile).not.toHaveBeenCalled();
    expect(host.vault.getFiles).not.toHaveBeenCalled();
    expect(host.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(host.vault.read).not.toHaveBeenCalled();
    expect(host.notices).toEqual([]);
    expect(host.modals.size).toBe(0);
    expectNoSideEffects(guards);
  });

  it("shows an explicit empty list, replaces old modals and releases text on close/unload", async () => {
    vi.spyOn(LocalInspectionService.prototype, "list").mockResolvedValue(
      emptyList,
    );
    const plugin = loadPlugin();
    await command("inspect-local-notes")();
    expect(modalText()).toEqual([
      "Eligible notes: 0",
      "No eligible local Markdown notes.",
      "Skipped files: 0",
      "Unsupported files: 0",
      "Excluded locations: 0",
      "Invalid paths: 0",
      "Oversized files: 0",
    ]);
    const [old] = [...host.modals];
    await command("inspect-local-notes")();
    expect(host.modals.size).toBe(1);
    expect(old?.contentEl.children).toEqual([]);
    const [current] = [...host.modals];
    plugin.unload();
    expect(host.modals.size).toBe(0);
    expect(current?.contentEl.children).toEqual([]);
    current?.onOpen();
    expect(current?.contentEl.children).toEqual([]);
  });

  it("captures the active literal path once and renders only success metadata as text", async () => {
    const path = "<img src=x onerror=alert(1)> a%20b 雪.md";
    if (!isNormalizedNotePath(path)) throw new Error("Invalid fixture");
    host.active = addFile(path);
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<LocalInspectionService["inspectActivePath"]>>
      >();
    const read = vi
      .spyOn(LocalInspectionService.prototype, "inspectActivePath")
      .mockReturnValue(pending.promise);
    const plugin = loadPlugin();
    const task = command("inspect-active-note")();
    host.active = addFile("other.md");
    pending.resolve({
      kind: LocalInspectionKind.ok,
      entry: { path, sizeBytes: 42 },
    });
    await task;
    expect(read).toHaveBeenCalledExactlyOnceWith(path);
    expect(host.getActiveFile).toHaveBeenCalledTimes(1);
    expect(host.notices.at(-1)?.message).toBe(
      `Saved note: ${path}\nUTF-8 bytes: 42\nSaved vault text only. Save and retry to include unsaved changes.`,
    );
    plugin.unload();
    expect(host.notices.every((notice) => notice.hidden)).toBe(true);
  });

  it.each([
    [
      LocalVaultFailureReason.noActiveFile,
      "No active file. Open a saved Markdown note and retry.",
    ],
    [
      LocalVaultFailureReason.unsupportedFile,
      "Only lowercase .md files can be inspected.",
    ],
    [
      LocalVaultFailureReason.excludedLocation,
      "This file is in an excluded location.",
    ],
    [
      LocalVaultFailureReason.invalidPath,
      "This file has an unsupported vault-relative path.",
    ],
    [
      LocalVaultFailureReason.missingFile,
      "The saved file is missing. Select an existing note and retry.",
    ],
    [
      LocalVaultFailureReason.oversized,
      "This note exceeds the 1 MiB inspection limit.",
    ],
    [
      LocalVaultFailureReason.changedDuringRead,
      "The saved file changed during inspection. Save and retry.",
    ],
    [
      LocalVaultFailureReason.unavailable,
      "Local inspection is unavailable. Please retry.",
    ],
  ])(
    "shows a sanitized notice for %s and releases busy state",
    async (reason, message) => {
      const read = vi
        .spyOn(LocalInspectionService.prototype, "inspectActivePath")
        .mockResolvedValue({ kind: LocalInspectionKind.failed, reason });
      const plugin = loadPlugin();
      await command("inspect-active-note")();
      expect(read).toHaveBeenCalledWith(null);
      expect(host.notices.at(-1)?.message).toBe(message);
      await command("inspect-active-note")();
      expect(read).toHaveBeenCalledTimes(2);
      expect(host.notices[0]?.hidden).toBe(true);
      plugin.unload();
    },
  );

  it("reports enumeration failure instead of an empty success", async () => {
    vi.spyOn(LocalInspectionService.prototype, "list").mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    });
    const plugin = loadPlugin();
    await command("inspect-local-notes")();
    expect(host.modals.size).toBe(0);
    expect(host.notices.at(-1)?.message).toBe(
      "Local inspection is unavailable. Please retry.",
    );
    plugin.unload();
  });

  it("rejects both overlapping commands without capturing another active file, then releases", async () => {
    const pending = Promise.withResolvers<LocalListResult>();
    const list = vi
      .spyOn(LocalInspectionService.prototype, "list")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(emptyList);
    const read = vi.spyOn(
      LocalInspectionService.prototype,
      "inspectActivePath",
    );
    const plugin = loadPlugin();
    const task = command("inspect-local-notes")();
    await command("inspect-active-note")();
    await command("inspect-local-notes")();
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "An inspection is already running.",
      "An inspection is already running.",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(host.getActiveFile).not.toHaveBeenCalled();
    pending.resolve(emptyList);
    await task;
    await command("inspect-local-notes")();
    expect(list).toHaveBeenCalledTimes(2);
    plugin.unload();
  });

  it.each([false, true])(
    "serializes across re-enable and suppresses stale list completion (reject=%s)",
    async (reject) => {
      const pending = Promise.withResolvers<LocalListResult>();
      const list = vi
        .spyOn(LocalInspectionService.prototype, "list")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(emptyList);
      const read = vi.spyOn(
        LocalInspectionService.prototype,
        "inspectActivePath",
      );
      const plugin = loadPlugin();
      const retained = command("inspect-local-notes");
      const task = retained();
      plugin.unload();
      await retained();
      expect(list).toHaveBeenCalledTimes(1);
      expect(host.commands.size).toBe(0);
      plugin.load();
      await command("inspect-active-note")();
      const currentNotice = host.notices.at(-1);
      const readCallsBeforeSettle = read.mock.calls.length;
      if (reject) pending.reject(new Error("PRIVATE BODY secret/path.md"));
      else pending.resolve(emptyList);
      await task;
      expect(list).toHaveBeenCalledTimes(1);
      expect(readCallsBeforeSettle).toBe(0);
      expect(currentNotice?.message).toBe("An inspection is already running.");
      expect(host.notices).toEqual([currentNotice]);
      expect(host.modals.size).toBe(0);
      await command("inspect-local-notes")();
      expect(list).toHaveBeenCalledTimes(2);
      expect(host.modals.size).toBe(1);
      plugin.unload();
      expect(currentNotice?.hidden).toBe(true);
    },
  );

  it("sanitizes thrown service/active-host failures and releases after each", async () => {
    const guards = sideEffectGuards();
    const list = vi
      .spyOn(LocalInspectionService.prototype, "list")
      .mockRejectedValueOnce(new Error("PRIVATE BODY secret/path.md"))
      .mockResolvedValue(emptyList);
    const plugin = loadPlugin();
    await command("inspect-local-notes")();
    host.getActiveFile.mockImplementationOnce(() => {
      throw new Error("PRIVATE BODY secret/path.md");
    });
    await command("inspect-active-note")();
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "Local inspection is unavailable. Please retry.",
      "Local inspection is unavailable. Please retry.",
    ]);
    await command("inspect-local-notes")();
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.modals.size).toBe(1);
    plugin.unload();
    expectNoSideEffects(guards);
  });
});
