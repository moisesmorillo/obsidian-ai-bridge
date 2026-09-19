import { ObsidianMirrorEvents } from "@obsidian-plugin/events/obsidian-mirror-events";
import {
  host,
  resetHost,
} from "@obsidian-plugin-tests/support/obsidian-runtime";
import { addFile } from "@obsidian-plugin-tests/support/plugin-fixture";
import { App, type EventRef, TFolder } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

function sink() {
  return {
    observePresent: vi.fn(async () => undefined),
    observeDelete: vi.fn(async () => undefined),
    observeRename: vi.fn(async () => undefined),
    observeFolderRename: vi.fn(async () => undefined),
  };
}

beforeEach(resetHost);

describe("ObsidianMirrorEvents", () => {
  it("registers official saved events and excludes editor-only changes", () => {
    const eventSink = sink();
    const registerEvent = vi.fn((_event: EventRef) => undefined);
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    expect(host.vault.on.mock.calls.map(([name]) => name)).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
    ]);
    expect(registerEvent).toHaveBeenCalledTimes(4);

    const file = addFile("note.md");
    host.workspaceOn("editor-change", file);
    expect(eventSink.observePresent).not.toHaveBeenCalled();
    host.emitVault("create", file);
    host.emitVault("modify", file);
    expect(eventSink.observePresent).toHaveBeenNthCalledWith(
      1,
      "note.md",
      "create",
    );
    expect(eventSink.observePresent).toHaveBeenNthCalledWith(
      2,
      "note.md",
      "modify",
    );
  });

  it("ignores preservation-file events because the reserved dot root is outside mirror eligibility", () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const file = addFile(
      ".ai-bridge-conflicts/11111111-1111-4111-8111-111111111111/local.md",
    );
    host.emitVault("create", file);
    host.emitVault("modify", file);
    host.emitVault("delete", file);
    expect(eventSink.observePresent).not.toHaveBeenCalled();
    expect(eventSink.observeDelete).not.toHaveBeenCalled();
  });

  it("captures immutable old/new file paths before host object mutation", () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const file = addFile("new.md");
    host.emitVault("rename", file, "old.md");
    file.path = "mutated-after-callback.md";
    expect(eventSink.observeRename).toHaveBeenCalledExactlyOnceWith(
      "old.md",
      "new.md",
    );
  });

  it("passes only primitive folder paths and hides excluded destinations", () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const folder = new TFolder();
    folder.path = ".private";
    host.emitVault("rename", folder, "public");
    folder.path = "mutated";
    expect(eventSink.observeFolderRename).toHaveBeenCalledExactlyOnceWith(
      "public",
      null,
    );
  });

  it("adapts eligible deletion and entry into scope while ignoring non-files", async () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const eligible = addFile("delete.md");
    host.emitVault("delete", eligible);
    host.emitVault("rename", eligible, ".private.md");
    const folder = new TFolder();
    folder.path = "folder";
    host.emitVault("create", folder);
    host.emitVault("delete", folder);
    host.emitVault("rename", folder, "old-folder");
    await Promise.resolve();
    expect(eventSink.observeDelete).toHaveBeenCalledExactlyOnceWith(
      "delete.md",
    );
    expect(eventSink.observePresent).toHaveBeenCalledExactlyOnceWith(
      "delete.md",
    );
    expect(eventSink.observeFolderRename).toHaveBeenNthCalledWith(
      1,
      "folder",
      null,
    );
    expect(eventSink.observeFolderRename).toHaveBeenNthCalledWith(
      2,
      "old-folder",
      "folder",
    );
  });

  it("contains asynchronous sink rejection at the event boundary", async () => {
    const failure = new Error("expected");
    const eventSink = {
      observePresent: vi.fn(async () => Promise.reject(failure)),
      observeDelete: vi.fn(async () => Promise.reject(failure)),
      observeRename: vi.fn(async () => Promise.reject(failure)),
      observeFolderRename: vi.fn(async () => Promise.reject(failure)),
    };
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const file = addFile("note.md");
    host.emitVault("create", file);
    host.emitVault("delete", file);
    host.emitVault("rename", file, "old.md");
    const folder = new TFolder();
    folder.path = "folder";
    host.emitVault("delete", folder);
    host.emitVault("rename", folder, "old-folder");
    await Promise.resolve();
    await Promise.resolve();
    expect(eventSink.observePresent).toHaveBeenCalledOnce();
    expect(eventSink.observeDelete).toHaveBeenCalledOnce();
    expect(eventSink.observeRename).toHaveBeenCalledOnce();
    expect(eventSink.observeFolderRename).toHaveBeenCalledTimes(2);
  });

  it("detaches stale callback admission immediately", () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    events.detach();
    host.emitVault("delete", addFile("note.md"));
    expect(eventSink.observeDelete).not.toHaveBeenCalled();
  });
});
