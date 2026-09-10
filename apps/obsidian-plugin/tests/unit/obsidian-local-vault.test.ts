import {
  isNormalizedNotePath,
  LocalInspectionKind,
  type LocalReadFailureReason,
  LocalSkipReason,
  LocalVaultFailureReason,
  MAX_NOTE_SIZE_BYTES,
  type NotePath,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import {
  FakeVaultHost,
  fakeFile,
} from "@obsidian-plugin-tests/support/fake-vault-host";
import { describe, expect, it, vi } from "vitest";

/**
 * Validates test inputs without bypassing the branded domain boundary.
 * @param path - Literal normalized name required by the read port.
 * @returns A checked NotePath, never an unchecked cast.
 */
function notePath(path: string): NotePath {
  if (!isNormalizedNotePath(path)) throw new Error("Invalid test path");
  return path;
}

const failed = (reason: LocalReadFailureReason) => ({
  kind: LocalInspectionKind.failed,
  reason,
});
const unavailable = failed(LocalVaultFailureReason.unavailable);
const changed = failed(LocalVaultFailureReason.changedDuringRead);

describe("ObsidianLocalVault.list", () => {
  it("is inert until invoked and lists metadata only with exactly one skip per refused file", async () => {
    const files = [
      fakeFile("z.md"),
      fakeFile("configuration/a.md", "é"),
      fakeFile("config/secret.md"),
      fakeFile(".hidden/a.md"),
      fakeFile("folder/.secret.md"),
      fakeFile("image.png"),
      fakeFile("config/UPPER.MD"),
      fakeFile("bad//path.md"),
      fakeFile("big.md", "", MAX_NOTE_SIZE_BYTES + 1),
    ];
    const host = new FakeVaultHost(files);
    const vault = new ObsidianLocalVault(host);
    expect(host.getFiles).not.toHaveBeenCalled();
    expect(host.getFile).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
    const before = structuredClone([...host.files]);
    expect(await vault.list()).toEqual({
      kind: LocalInspectionKind.ok,
      entries: [
        { path: "z.md", sizeBytes: 10 },
        { path: "configuration/a.md", sizeBytes: 2 },
      ],
      skipped: {
        unsupported_file: 2,
        excluded_location: 3,
        invalid_path: 1,
        oversized: 1,
      },
    });
    expect(host.getFiles).toHaveBeenCalledTimes(1);
    expect(host.getFile).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
    expect([...host.files]).toEqual(before);
  });

  it("returns a real empty success", async () => {
    expect(await new ObsidianLocalVault(new FakeVaultHost()).list()).toEqual({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "fails without a partial result for malformed eligible size %s",
    async (size) => {
      const host = new FakeVaultHost([
        fakeFile("good.md"),
        fakeFile("bad.md", "secret", size),
      ]);
      expect(await new ObsidianLocalVault(host).list()).toEqual(unavailable);
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it("keeps path reasons ahead of malformed sizes", async () => {
    const host = new FakeVaultHost([
      fakeFile("config/a.md", "", NaN),
      fakeFile("a.txt", "", NaN),
      fakeFile("a//b.md", "", NaN),
    ]);
    expect(await new ObsidianLocalVault(host).list()).toEqual({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 1,
        excluded_location: 1,
        invalid_path: 1,
        oversized: 0,
      },
    });
  });

  it("sanitizes an enumeration exception", async () => {
    const host = new FakeVaultHost();
    host.getFiles.mockImplementation(() => {
      throw new Error("sensitive/path.md secret");
    });
    expect(await new ObsidianLocalVault(host).list()).toEqual(unavailable);
  });
});

describe("ObsidianLocalVault.read", () => {
  it.each(["100%.md", "a%20b.md", "folder/a b.md", "日本語/é.md"])(
    "looks up and reads the exact saved identity %s once without changing files",
    async (path) => {
      const file = fakeFile(path, "private saved text");
      const alternate = fakeFile("a b.md", "not selected");
      const host = new FakeVaultHost([file, alternate]);
      const before = structuredClone([...host.files]);
      expect(await new ObsidianLocalVault(host).read(notePath(path))).toEqual({
        kind: LocalInspectionKind.ok,
        content: file.content,
        sizeBytes: file.stat.size,
      });
      expect(host.getFile.mock.calls).toEqual([[path], [path]]);
      expect(host.read).toHaveBeenCalledExactlyOnceWith(file);
      expect(host.getFiles).not.toHaveBeenCalled();
      expect([...host.files]).toEqual(before);
    },
  );

  it.each(["config/a.md", ".obsidian/a.md", "folder/.private/a.md"])(
    "excludes %s before lookup or read",
    async (path) => {
      const host = new FakeVaultHost([fakeFile(path)]);
      expect(await new ObsidianLocalVault(host).read(notePath(path))).toEqual(
        failed(LocalSkipReason.excludedLocation),
      );
      expect(host.getFile).not.toHaveBeenCalled();
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it("uses the host's configured directory rather than a hard-coded name", async () => {
    const host = new FakeVaultHost(
      [fakeFile("settings/private.md"), fakeFile("settings-other/a.md")],
      "settings",
    );
    const vault = new ObsidianLocalVault(host);
    expect(vault.policy).toEqual({ configDirectory: "settings" });
    expect(await vault.read(notePath("settings/private.md"))).toEqual(
      failed(LocalSkipReason.excludedLocation),
    );
    expect((await vault.read(notePath("settings-other/a.md"))).kind).toBe(
      LocalInspectionKind.ok,
    );
    expect(host.read).toHaveBeenCalledTimes(1);
  });

  it("fails missing without fallback lookup or body access", async () => {
    const host = new FakeVaultHost([fakeFile("other.md")]);
    expect(
      await new ObsidianLocalVault(host).read(notePath("missing.md")),
    ).toEqual(failed(LocalVaultFailureReason.missingFile));
    expect(host.getFile.mock.calls).toEqual([["missing.md"]]);
    expect(host.read).not.toHaveBeenCalled();
  });

  it("rejects a mismatched lookup identity rather than reading another path", async () => {
    const host = new FakeVaultHost();
    host.getFile.mockReturnValue(fakeFile("other.md"));
    expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual(
      changed,
    );
    expect(host.read).not.toHaveBeenCalled();
  });

  it.each([
    { content: "", sizeBytes: 0 },
    {
      content: "a".repeat(MAX_NOTE_SIZE_BYTES),
      sizeBytes: MAX_NOTE_SIZE_BYTES,
    },
    {
      content: "é".repeat(MAX_NOTE_SIZE_BYTES / 2),
      sizeBytes: MAX_NOTE_SIZE_BYTES,
    },
    { content: "😀é", sizeBytes: 6 },
  ])("accepts $sizeBytes UTF-8 bytes", async ({ content, sizeBytes }) => {
    const host = new FakeVaultHost([fakeFile("a.md", content)]);
    expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual({
      kind: LocalInspectionKind.ok,
      content,
      sizeBytes,
    });
  });

  it("refuses known oversized metadata without buffering", async () => {
    const host = new FakeVaultHost([
      fakeFile("a.md", "private", MAX_NOTE_SIZE_BYTES + 1),
    ]);
    expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual(
      failed(LocalSkipReason.oversized),
    );
    expect(host.read).not.toHaveBeenCalled();
  });

  it.each([
    "a".repeat(MAX_NOTE_SIZE_BYTES + 1),
    "é".repeat(MAX_NOTE_SIZE_BYTES / 2 + 1),
  ])(
    "refuses oversized actual bytes despite small metadata %#",
    async (content) => {
      const host = new FakeVaultHost([fakeFile("a.md", content, 1)]);
      expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual(
        failed(LocalSkipReason.oversized),
      );
      expect(host.read).toHaveBeenCalledTimes(1);
    },
  );

  it("reports measured bytes, not misleading stable metadata", async () => {
    const host = new FakeVaultHost([fakeFile("a.md", "é", 1)]);
    expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual({
      kind: LocalInspectionKind.ok,
      content: "é",
      sizeBytes: 2,
    });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses malformed pre-read size %s",
    async (size) => {
      const host = new FakeVaultHost([fakeFile("a.md", "secret", size)]);
      expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual(
        unavailable,
      );
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "refuses non-finite pre-read mtime %s",
    async (mtime) => {
      const file = fakeFile("a.md");
      file.stat.mtime = mtime;
      const host = new FakeVaultHost([file]);
      expect(await new ObsidianLocalVault(host).read(notePath("a.md"))).toEqual(
        unavailable,
      );
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    "disappearance",
    "replacement",
    "rename",
    "mtime",
    "size",
    "oversized size",
    "invalid size",
    "invalid mtime",
    "excluded rename",
  ])(
    "refuses observed %s during the await without content or retry",
    async (change) => {
      const file = fakeFile("a.md", "sensitive body");
      const host = new FakeVaultHost([file]);
      const pending = Promise.withResolvers<string>();
      host.read.mockReturnValue(pending.promise);
      const result = new ObsidianLocalVault(host).read(notePath("a.md"));
      expect(host.read).toHaveBeenCalledExactlyOnceWith(file);
      switch (change) {
        case "disappearance":
          host.files.delete("a.md");
          break;
        case "replacement":
          host.files.set("a.md", fakeFile("a.md", file.content));
          break;
        case "rename":
          file.path = "renamed.md";
          break;
        case "mtime":
          file.stat.mtime += 1;
          break;
        case "size":
          file.stat.size += 1;
          break;
        case "oversized size":
          file.stat.size = MAX_NOTE_SIZE_BYTES + 1;
          break;
        case "invalid size":
          file.stat.size = NaN;
          break;
        case "invalid mtime":
          file.stat.mtime = NaN;
          break;
        case "excluded rename":
          file.path = "config/private.md";
          break;
      }
      pending.resolve(file.content);
      expect(await result).toEqual(changed);
      expect(host.read).toHaveBeenCalledTimes(1);
      expect(host.getFile.mock.calls).toEqual([["a.md"], ["a.md"]]);
    },
  );

  it.each(["initial lookup", "read", "post lookup", "stat access"])(
    "sanitizes %s exceptions",
    async (operation) => {
      const file = fakeFile("a.md");
      const host = new FakeVaultHost([file]);
      const error = new Error("secret body and sensitive/path.md");
      switch (operation) {
        case "initial lookup":
          host.getFile.mockImplementation(() => {
            throw error;
          });
          break;
        case "read":
          host.read.mockRejectedValue(error);
          break;
        case "post lookup":
          host.getFile.mockReturnValueOnce(file).mockImplementation(() => {
            throw error;
          });
          break;
        case "stat access":
          Object.defineProperty(file, "stat", {
            get() {
              throw error;
            },
          });
          break;
      }
      const log = vi.spyOn(console, "error");
      try {
        expect(
          await new ObsidianLocalVault(host).read(notePath("a.md")),
        ).toEqual(unavailable);
        expect(host.read.mock.calls.length).toBeLessThanOrEqual(1);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );
});
