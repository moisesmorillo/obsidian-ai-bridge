import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  command,
  loadPluginReady,
  modalText,
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

describe("mirror operational commands", () => {
  it("shows sanitized status and composes only whole-mirror operational actions", async () => {
    const plugin = await loadPluginReady();
    await command("show-mirror-status")();
    expect(modalText()).toEqual([
      expect.stringContaining("Configuration: unconfigured"),
    ]);
    expect(modalText().join("\n")).not.toMatch(/bearer|PRIVATE|response body/i);

    for (const id of [
      "check-mirror-now",
      "retry-mirror-failures",
      "pause-mirror",
      "resume-mirror",
      "prepare-writer-handoff",
    ]) {
      await command(id)();
    }
    await vi.waitFor(() => expect(host.notices).toHaveLength(5));
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "Mirror operation is not ready or could not complete.",
      "Mirror operation is not ready or could not complete.",
      "Mirror operation is not ready or could not complete.",
      "Mirror operation is not ready or could not complete.",
      "Handoff is not ready. Resolve pending or blocked work first.",
    ]);
    expect([...host.commands.keys()]).not.toContain(
      "ai-bridge:delete-note-remotely",
    );
    const modal = [...host.modals][0];
    plugin.unload();
    expect(modal?.contentEl.children).toEqual([]);
    expect(host.notices.every((notice) => notice.hidden)).toBe(true);
  });
});
