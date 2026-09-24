import {
  LEGACY_RECONCILIATION_PRESERVATION_ROOT,
  RECONCILIATION_PRESERVATION_ROOT,
} from "@obsidian-ai-bridge/core";
import { ObsidianMirrorEvents } from "@obsidian-plugin/events/obsidian-mirror-events";
import { MAX_QUEUED_OBSERVATION_EVENTS } from "@obsidian-plugin/events/obsidian-mirror-events.constants";
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
    observeFolderRename: vi.fn(async () => null),
    failObservationDelivery: vi.fn(async () => undefined),
  };
}

beforeEach(resetHost);

async function activate(events: ObsidianMirrorEvents): Promise<void> {
  expect(await events.drainQueued()).toBe(true);
  expect(events.activate()).toBe(true);
}

describe("ObsidianMirrorEvents", () => {
  it("registers official saved events and excludes editor-only changes", async () => {
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
    expect(eventSink.observePresent).not.toHaveBeenCalled();
    await activate(events);
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

  it.each([
    RECONCILIATION_PRESERVATION_ROOT,
    LEGACY_RECONCILIATION_PRESERVATION_ROOT,
  ])("excludes every file and folder event from reserved root %s", (root) => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const path = `${root}/11111111-1111-4111-8111-111111111111/local.md`;
    const file = addFile(path);
    host.emitVault("create", file);
    host.emitVault("modify", file);
    host.emitVault("delete", file);
    file.path = "notes/moved-artifact.md";
    host.emitVault("rename", file, path);
    const folder = new TFolder();
    folder.path = root;
    host.emitVault("delete", folder);
    folder.path = "moved-artifacts";
    host.emitVault("rename", folder, root);
    expect(eventSink.observePresent).not.toHaveBeenCalled();
    expect(eventSink.observeDelete).not.toHaveBeenCalled();
    expect(eventSink.observeRename).not.toHaveBeenCalled();
    expect(eventSink.observeFolderRename).not.toHaveBeenCalled();
  });

  it("captures immutable old/new file paths before host object mutation", async () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    await activate(events);
    const file = addFile("new.md");
    host.emitVault("rename", file, "old.md");
    file.path = "mutated-after-callback.md";
    expect(eventSink.observeRename).toHaveBeenCalledExactlyOnceWith(
      "old.md",
      "new.md",
    );
  });

  it("passes only primitive folder paths and hides excluded destinations", async () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    await activate(events);
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
    await activate(events);
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
      "modify",
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

  it("keeps attachment idempotent and refuses activation after detach", async () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );

    expect(events.attach()).toBe(true);
    expect(events.attach()).toBe(true);
    events.detach();

    expect(await events.drainQueued()).toBe(false);
    expect(events.activate()).toBe(false);
    host.emitVault("create", addFile("detached.md"));
    expect(eventSink.observePresent).not.toHaveBeenCalled();
  });

  it("fails closed after asynchronous event delivery rejects", async () => {
    const failure = new Error("expected");
    const eventSink = {
      ...sink(),
      observePresent: vi.fn(async () => Promise.reject(failure)),
    };
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    await activate(events);
    host.emitVault("create", addFile("note.md"));
    await vi.waitFor(() =>
      expect(eventSink.failObservationDelivery).toHaveBeenCalledOnce(),
    );

    host.emitVault("modify", addFile("later.md"));
    expect(eventSink.observePresent).toHaveBeenCalledOnce();
  });

  it("fails closed when official listener registration throws", () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      {
        registerEvent: () => {
          throw new Error("registration unavailable");
        },
      },
      eventSink,
      { configDirectory: "host-settings" },
    );

    expect(events.attach()).toBe(false);
    expect(events.attach()).toBe(false);
    host.emitVault("create", addFile("note.md"));
    expect(eventSink.observePresent).not.toHaveBeenCalled();
    expect(eventSink.failObservationDelivery).toHaveBeenCalledOnce();
  });

  it("refuses startup activation after a queued sink rejects", async () => {
    const eventSink = {
      ...sink(),
      observePresent: vi.fn(async () =>
        Promise.reject(new Error("write failed")),
      ),
    };
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );

    expect(events.attach()).toBe(true);
    host.emitVault("create", addFile("note.md"));
    expect(await events.drainQueued()).toBe(false);
    expect(events.activate()).toBe(false);
    expect(eventSink.observePresent).toHaveBeenCalledExactlyOnceWith(
      "note.md",
      "create",
    );
  });

  it("fails closed rather than dropping events when the startup queue overflows", async () => {
    const eventSink = sink();
    const events = new ObsidianMirrorEvents(
      new App().vault,
      { registerEvent: () => undefined },
      eventSink,
      { configDirectory: "host-settings" },
    );
    events.attach();
    const file = addFile("note.md");
    Array.from({ length: MAX_QUEUED_OBSERVATION_EVENTS + 1 }).forEach(() => {
      host.emitVault("modify", file);
    });

    await vi.waitFor(() =>
      expect(eventSink.failObservationDelivery).toHaveBeenCalledOnce(),
    );
    expect(await events.drainQueued()).toBe(false);
    expect(events.activate()).toBe(false);
    expect(eventSink.observePresent).not.toHaveBeenCalled();
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
