import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  addFile,
  command,
  expectNoSideEffects,
  loadPlugin,
  modalText,
  sideEffectGuards,
} from "@obsidian-plugin-tests/support/plugin-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

beforeEach(resetHost);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local inspection commands → service → official Obsidian adapter", () => {
  it("lists exact text metadata in lexical order, reads saved active text once, and changes no files or state", async () => {
    const guards = sideEffectGuards();
    const path = "<img src=x onerror=alert(1)> a%20b 雪.md";
    const active = addFile(path, "PRIVATE BODY 雪");
    addFile("z.md", "PRIVATE SECOND BODY");
    addFile("100%.md", "PRIVATE THIRD BODY");
    addFile("a b.md", "PRIVATE FOURTH BODY");
    addFile("a%20b.md", "PRIVATE FIFTH BODY");
    addFile("image.png");
    addFile("host-settings/secret.md");
    addFile(".hidden/secret.md");
    addFile("bad//name.md");
    addFile("oversized.md", "PRIVATE LARGE BODY", MAX_NOTE_SIZE_BYTES + 1);
    host.active = active;
    const beforeFiles = structuredClone([...host.files]);
    const beforeContents = [...host.contents];
    const plugin = loadPlugin();
    expect(host.vault.getFiles).not.toHaveBeenCalled();
    expect(host.vault.read).not.toHaveBeenCalled();
    await command("inspect-local-notes")();
    expect(host.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(host.vault.read).not.toHaveBeenCalled();
    expect(host.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(modalText()).toEqual([
      "Eligible notes: 5",
      "100%.md — 18 bytes",
      `${path} — 16 bytes`,
      "a b.md — 19 bytes",
      "a%20b.md — 18 bytes",
      "z.md — 19 bytes",
      "Skipped files: 5",
      "Unsupported files: 1",
      "Excluded locations: 2",
      "Invalid paths: 1",
      "Oversized files: 1",
    ]);
    const [modal] = [...host.modals];
    expect(
      modal?.contentEl.createEl.mock.calls.every(
        ([, options]) => typeof options.text === "string",
      ),
    ).toBe(true);
    await command("inspect-active-note")();
    expect(host.vault.read).toHaveBeenCalledExactlyOnceWith(active);
    expect(host.vault.getAbstractFileByPath.mock.calls).toEqual([
      [path],
      [path],
    ]);
    expect(host.notices.at(-1)?.message).toBe(
      `Saved note: ${path}\nUTF-8 bytes: 16\nSaved vault text only. Save and retry to include unsaved changes.`,
    );
    const output = [
      ...modalText(),
      ...host.notices.map((notice) => notice.message),
    ].join("\n");
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("secret.md");
    expect(output).not.toContain("bad//name.md");
    expect([...host.files]).toEqual(beforeFiles);
    expect([...host.contents]).toEqual(beforeContents);
    plugin.unload();
    expect(host.commands.size).toBe(0);
    expect(host.modals.size).toBe(0);
    expect(modal?.contentEl.children).toEqual([]);
    expectNoSideEffects(guards);
  });

  it.each([
    [null, "No active file. Open a saved Markdown note and retry."],
    ["note.MD", "Only lowercase .md files can be inspected."],
    ["image.png", "Only lowercase .md files can be inspected."],
    ["host-settings/secret.md", "This file is in an excluded location."],
    [".hidden/secret.md", "This file is in an excluded location."],
    ["bad//note.md", "This file has an unsupported vault-relative path."],
    ["a%2fb.md", "This file has an unsupported vault-relative path."],
    ["oversized.md", "This note exceeds the 1 MiB inspection limit."],
  ])(
    "refuses active %s without reading bodies or changing saved state",
    async (path, message) => {
      const guards = sideEffectGuards();
      host.active =
        path === null
          ? null
          : addFile(path, "PRIVATE BODY", MAX_NOTE_SIZE_BYTES + 1);
      const before = [...host.contents];
      const plugin = loadPlugin();
      await command("inspect-active-note")();
      expect(host.notices.at(-1)?.message).toBe(message);
      expect(host.vault.read).not.toHaveBeenCalled();
      expect(host.vault.getFiles).not.toHaveBeenCalled();
      expect([...host.contents]).toEqual(before);
      plugin.unload();
      expectNoSideEffects(guards);
    },
  );

  it("does not substitute another note when the captured file is missing", async () => {
    const plugin = loadPlugin();
    const missing = addFile("missing.md");
    addFile("other.md");
    host.active = missing;
    host.files.delete(missing.path);
    await command("inspect-active-note")();
    expect(host.notices.at(-1)?.message).toBe(
      "The saved file is missing. Select an existing note and retry.",
    );
    expect(host.vault.read).not.toHaveBeenCalled();
    expect(host.vault.getAbstractFileByPath).toHaveBeenCalledExactlyOnceWith(
      "missing.md",
    );
    plugin.unload();
  });

  it("keeps the invocation target during pane changes and rejects both overlapping operations", async () => {
    const guards = sideEffectGuards();
    const original = addFile("100%.md", "雪");
    const other = addFile("other.md", "PRIVATE OTHER BODY");
    host.active = original;
    const pending = Promise.withResolvers<string>();
    host.vault.read.mockReturnValueOnce(pending.promise);
    const plugin = loadPlugin();
    const task = command("inspect-active-note")();
    host.active = other;
    await command("inspect-local-notes")();
    await command("inspect-active-note")();
    expect(host.vault.getFiles).not.toHaveBeenCalled();
    expect(host.vault.read).toHaveBeenCalledExactlyOnceWith(original);
    expect(host.getActiveFile).toHaveBeenCalledTimes(1);
    expect(
      host.notices.every(
        (notice) => notice.message === "An inspection is already running.",
      ),
    ).toBe(true);
    pending.resolve("雪");
    await task;
    expect(host.notices.at(-1)?.message).toContain(
      "Saved note: 100%.md\nUTF-8 bytes: 3",
    );
    await command("inspect-active-note")();
    expect(host.vault.read).toHaveBeenLastCalledWith(other);
    expect(host.vault.read).toHaveBeenCalledTimes(2);
    plugin.unload();
    expectNoSideEffects(guards);
  });

  it.each(["edit", "rename", "remove", "replace"])(
    "reports host %s during read without retry or product writes",
    async (change) => {
      const guards = sideEffectGuards();
      const file = addFile("active.md");
      host.active = file;
      const pending = Promise.withResolvers<string>();
      host.vault.read.mockReturnValueOnce(pending.promise);
      const plugin = loadPlugin();
      const task = command("inspect-active-note")();
      switch (change) {
        case "edit":
          file.stat.mtime += 1;
          break;
        case "rename":
          file.path = "renamed.md";
          break;
        case "remove":
          host.files.delete(file.path);
          break;
        case "replace":
          addFile(file.path, "EXTERNAL REPLACEMENT");
          break;
      }
      const hostFilesAfterExternalChange = structuredClone([...host.files]);
      const hostContentsAfterExternalChange = [...host.contents];
      pending.resolve("PRIVATE BODY");
      await task;
      expect(host.notices.at(-1)?.message).toBe(
        "The saved file changed during inspection. Save and retry.",
      );
      expect(host.vault.read).toHaveBeenCalledTimes(1);
      expect([...host.files]).toEqual(hostFilesAfterExternalChange);
      expect([...host.contents]).toEqual(hostContentsAfterExternalChange);
      await command("inspect-local-notes")();
      expect(host.vault.getFiles).toHaveBeenCalledTimes(1);
      plugin.unload();
      expectNoSideEffects(guards);
    },
  );

  it("rejects oversized actual UTF-8 text without truncation or disclosure", async () => {
    const guards = sideEffectGuards();
    host.active = addFile(
      "misleading.md",
      "雪".repeat(Math.ceil(MAX_NOTE_SIZE_BYTES / 3)),
      1,
    );
    const before = [...host.contents];
    const plugin = loadPlugin();
    await command("inspect-active-note")();
    expect(host.notices.at(-1)?.message).toBe(
      "This note exceeds the 1 MiB inspection limit.",
    );
    expect(host.vault.read).toHaveBeenCalledTimes(1);
    expect([...host.contents]).toEqual(before);
    plugin.unload();
    expectNoSideEffects(guards);
  });

  it("recovers after rejected enumeration/read with no raw exception, automatic retry or persisted report", async () => {
    const guards = sideEffectGuards();
    host.active = addFile("sensitive.md");
    const before = [...host.contents];
    host.vault.getFiles.mockImplementationOnce(() => {
      throw new Error("PRIVATE BODY sensitive.md");
    });
    host.vault.read.mockRejectedValueOnce(
      new Error("PRIVATE BODY sensitive.md"),
    );
    const plugin = loadPlugin();
    await command("inspect-local-notes")();
    expect(host.modals.size).toBe(0);
    await command("inspect-active-note")();
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "Local inspection is unavailable. Please retry.",
      "Local inspection is unavailable. Please retry.",
    ]);
    expect(host.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(host.vault.read).toHaveBeenCalledTimes(1);
    await command("inspect-active-note")();
    expect(host.notices.at(-1)?.message).toContain("Saved note: sensitive.md");
    expect(host.vault.read).toHaveBeenCalledTimes(2);
    expect([...host.contents]).toEqual(before);
    plugin.unload();
    expectNoSideEffects(guards);
  });

  it.each([false, true])(
    "suppresses active completion after unload (reject=%s) and releases registrations/UI",
    async (reject) => {
      const guards = sideEffectGuards();
      host.active = addFile("private.md");
      const before = [...host.contents];
      const pending = Promise.withResolvers<string>();
      host.vault.read.mockReturnValueOnce(pending.promise);
      const plugin = loadPlugin();
      const retained = command("inspect-active-note");
      const task = retained();
      await command("inspect-local-notes")();
      const noticeCount = host.notices.length;
      plugin.unload();
      await retained();
      if (reject) pending.reject(new Error("PRIVATE BODY private.md"));
      else pending.resolve("PRIVATE BODY");
      await task;
      expect(host.commands.size).toBe(0);
      expect(host.notices).toHaveLength(noticeCount);
      expect(host.notices.every((notice) => notice.hidden)).toBe(true);
      expect(host.modals.size).toBe(0);
      expect(host.vault.read).toHaveBeenCalledTimes(1);
      expect(host.vault.getFiles).not.toHaveBeenCalled();
      expect([...host.contents]).toEqual(before);
      expectNoSideEffects(guards);
    },
  );
});
