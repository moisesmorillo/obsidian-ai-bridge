import {
  type ContentSha256,
  createContentSha256,
  createMirrorOperationId,
  evaluateLocalNotePath,
  isNormalizedNotePath,
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_REFUSAL,
  LocalInspectionKind,
  type LocalReconciliationWriteCryptography,
  LocalSkipReason,
  MAX_NOTE_SIZE_BYTES,
  type MirrorOperationId,
  type NotePath,
  RECONCILIATION_PRESERVATION_SIDE,
} from "@obsidian-ai-bridge/core";
import { ObsidianLocalReconciliationWriter } from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer";
import type {
  ObsidianLocalReconciliationHost,
  ObsidianReconciliationFile,
  ObsidianReconciliationNode,
} from "@obsidian-plugin/infrastructure/obsidian-local-reconciliation-writer.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Mutable saved-file double used only by the narrow host fixture. */
interface WriterFile extends ObsidianReconciliationFile {
  readonly path: string;
  readonly stat: { size: number; mtime: number };
  content: string;
}

/** Official-capability host double with no delete/rename/move methods. */
class WriterHost implements ObsidianLocalReconciliationHost<WriterFile> {
  readonly nodes = new Map<string, ObsidianReconciliationNode<WriterFile>>();
  readonly policy: { readonly configDirectory: string };
  /** @param path - Exact fixture path. @returns Current node identity or null. */
  readonly lookup = vi.fn((path: string) => this.nodes.get(path) ?? null);
  /** @param path - Exact folder path to seed through the host capability. */
  readonly createFolder = vi.fn(async (path: string) => {
    if (this.nodes.has(path)) throw new Error("collision");
    this.nodes.set(path, { kind: "folder" });
  });
  /** @param path - Exact file path. @param content - Initial saved text. @returns Created file identity. */
  readonly create = vi.fn(async (path: string, content: string) => {
    if (this.nodes.has(path)) throw new Error("collision");
    const file = writerFile(path, content);
    this.nodes.set(path, { kind: "file", file });
    return file;
  });
  /** @param file - Captured file identity. @returns Its current saved text. */
  readonly read = vi.fn(async (file: WriterFile) => file.content);
  /** @param file - Captured file identity. @param update - Atomic text transform. @returns Saved replacement text. */
  readonly process = vi.fn(
    async (file: WriterFile, update: (current: string) => string) => {
      const content = update(file.content);
      file.content = content;
      file.stat.size = new TextEncoder().encode(content).byteLength;
      file.stat.mtime += 1;
      return content;
    },
  );

  /** @param configDirectory - Exact host config subtree used by path policy. */
  constructor(configDirectory = ".obsidian") {
    this.policy = { configDirectory };
  }

  /**
   * Seeds a file without invoking the product write capability.
   *
   * @param path - Exact fixture path.
   * @param content - Initial fixture text.
   * @returns Seeded mutable file identity.
   */
  file(path: string, content: string): WriterFile {
    const file = writerFile(path, content);
    this.nodes.set(path, { kind: "file", file });
    return file;
  }

  /**
   * Seeds a folder without invoking the product write capability.
   *
   * @param path - Exact fixture folder path.
   */
  folder(path: string): void {
    this.nodes.set(path, { kind: "folder" });
  }
}

/**
 * @param path - Exact fixture path.
 * @param content - Initial fixture text.
 * @returns A mutable file with measured UTF-8 metadata.
 */
function writerFile(path: string, content: string): WriterFile {
  return {
    path,
    content,
    stat: {
      size: new TextEncoder().encode(content).byteLength,
      mtime: 1,
    },
  };
}

/**
 * @param value - Optional validated fixture identity.
 * @returns The required identity.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid fixture identity.");
  return value;
}

/**
 * @param value - Candidate fixture path.
 * @returns An exact validated test path.
 */
function notePath(value: string): NotePath {
  if (!isNormalizedNotePath(value)) throw new Error("Invalid fixture path.");
  return value;
}

/**
 * @param content - Fixture text to identify deterministically.
 * @returns A deterministic valid SHA-256-shaped digest.
 */
function digest(content: string): ContentSha256 {
  const byte =
    new TextEncoder().encode(content).reduce((sum, value) => sum + value, 0) %
    256;
  return required(
    createContentSha256(byte.toString(16).padStart(2, "0").repeat(32)),
  );
}

const OPERATION = required(
  createMirrorOperationId("11111111-1111-4111-8111-111111111111"),
);
const OTHER_OPERATION = required(
  createMirrorOperationId("22222222-2222-4222-8222-222222222222"),
);
const PATH = notePath("notes/target.md");
const cryptography: LocalReconciliationWriteCryptography = {
  hashContent: vi.fn(async (content) => digest(content)),
};

/**
 * @param content - Exact text to create.
 * @param path - Exact eligible destination.
 * @returns A first-dispatch create request.
 */
function createRequest(content = "remote", path = PATH) {
  return {
    operationId: OPERATION,
    path,
    content,
    contentSha256: digest(content),
    mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
  } as const;
}

/**
 * @param expected - Exact current text predicate.
 * @param replacement - Exact replacement text.
 * @returns An exact first-dispatch replacement request.
 */
function replaceRequest(expected = "local", replacement = "remote") {
  return {
    operationId: OPERATION,
    path: PATH,
    expectedContent: expected,
    expectedContentSha256: digest(expected),
    expectedObservationGeneration: 7,
    replacementContent: replacement,
    replacementContentSha256: digest(replacement),
    mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
  } as const;
}

/**
 * @param content - Exact competing text to preserve.
 * @returns A generated preservation request with no path input.
 */
function preservationRequest(content = "competitor") {
  return {
    operationId: OPERATION,
    side: RECONCILIATION_PRESERVATION_SIDE.local,
    content,
    contentSha256: digest(content),
    mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ObsidianLocalReconciliationWriter.createEligible", () => {
  it("creates missing parents and returns exact reread/hash evidence", async () => {
    const host = new WriterHost();
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(
      writer.createEligible(createRequest("é remote")),
    ).resolves.toEqual({
      kind: "confirmed",
      outcome: "created",
      path: PATH,
      contentSha256: digest("é remote"),
      sizeBytes: 9,
    });
    expect(host.createFolder).toHaveBeenCalledExactlyOnceWith("notes");
    expect(host.create).toHaveBeenCalledExactlyOnceWith(PATH, "é remote");
    expect(host.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["file", LOCAL_RECONCILIATION_REFUSAL.destinationFileExists],
    ["folder", LOCAL_RECONCILIATION_REFUSAL.destinationFolderExists],
  ] as const)("refuses an existing destination %s", async (kind, reason) => {
    const host = new WriterHost();
    if (kind === "file") {
      host.file(PATH, "existing");
    } else {
      host.folder(PATH);
    }
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(writer.createEligible(createRequest())).resolves.toMatchObject(
      {
        kind: "refused",
        reason,
        effect: "definitely-refused",
      },
    );
    expect(host.create).not.toHaveBeenCalled();
  });

  it("refuses parent-file collisions, invalid/excluded paths, and oversized text before create", async () => {
    const host = new WriterHost();
    host.file("notes", "blocker");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(writer.createEligible(createRequest())).resolves.toMatchObject(
      {
        reason: LOCAL_RECONCILIATION_REFUSAL.parentFileCollision,
      },
    );
    await expect(
      writer.createEligible(createRequest("x", notePath(".hidden/a.md"))),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.excludedPath,
    });
    await expect(
      writer.createEligible({
        ...createRequest("x"),
        path: "notes/UPPER.MD" as NotePath,
      }),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.invalidPath,
    });
    const oversized = "x".repeat(MAX_NOTE_SIZE_BYTES + 1);
    await expect(
      writer.createEligible(createRequest(oversized)),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.oversized,
    });
    expect(host.create).not.toHaveBeenCalled();
  });

  it("reports create rejection and reread mismatch as unknown effects", async () => {
    const failedHost = new WriterHost();
    failedHost.folder("notes");
    failedHost.create.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        failedHost,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });

    const mismatchHost = new WriterHost();
    mismatchHost.folder("notes");
    mismatchHost.read.mockResolvedValueOnce("different");
    await expect(
      new ObsidianLocalReconciliationWriter(
        mismatchHost,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "postcondition-mismatch",
      effect: "unknown",
    });
  });

  it("classifies preflight lookup/hash failures without dispatch and parent-folder failures as unknown", async () => {
    const lookupHost = new WriterHost();
    lookupHost.lookup.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        lookupHost,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const hashFailure = new WriterHost();
    const failedCryptography: LocalReconciliationWriteCryptography = {
      hashContent: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };
    await expect(
      new ObsidianLocalReconciliationWriter(
        hashFailure,
        failedCryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const folderFailure = new WriterHost();
    folderFailure.createFolder.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        folderFailure,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });
  });

  it("classifies parent lookup and post-create verification races conservatively", async () => {
    const parentLookup = new WriterHost();
    parentLookup.lookup.mockImplementation((path) => {
      if (path === "notes") throw new Error("unavailable");
      return parentLookup.nodes.get(path) ?? null;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        parentLookup,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const postFolderLookup = new WriterHost();
    let parentLookups = 0;
    postFolderLookup.lookup.mockImplementation((path) => {
      if (path === "notes") {
        parentLookups += 1;
        if (parentLookups === 2) throw new Error("ambiguous");
      }
      return postFolderLookup.nodes.get(path) ?? null;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        postFolderLookup,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });

    const postCreateLookup = new WriterHost();
    postCreateLookup.folder("notes");
    postCreateLookup.lookup.mockImplementation((path) => {
      if (path === PATH && postCreateLookup.nodes.has(PATH)) {
        throw new Error("ambiguous");
      }
      return postCreateLookup.nodes.get(path) ?? null;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        postCreateLookup,
        cryptography,
      ).createEligible(createRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "postcondition-mismatch",
      effect: "unknown",
    });
  });

  it("refuses recovery adoption when the reread path identity changes", async () => {
    const host = new WriterHost();
    const file = host.file(PATH, "remote");
    host.read.mockImplementationOnce(async () => {
      host.nodes.delete(PATH);
      return file.content;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(host, cryptography).createEligible({
        ...createRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: LOCAL_RECONCILIATION_REFUSAL.destinationFileExists,
    });
  });

  it("adopts only exact same-operation recovery bytes", async () => {
    const host = new WriterHost();
    host.file(PATH, "remote");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(
      writer.createEligible({
        ...createRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({ kind: "confirmed", outcome: "adopted" });
    host.file(PATH, "other");
    await expect(
      writer.createEligible({
        ...createRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: LOCAL_RECONCILIATION_REFUSAL.destinationFileExists,
    });
  });
});

describe("ObsidianLocalReconciliationWriter.replaceEligible", () => {
  it("uses atomic exact-text processing and verifies the reread", async () => {
    const host = new WriterHost();
    host.file(PATH, "local");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(writer.replaceEligible(replaceRequest())).resolves.toEqual({
      kind: "confirmed",
      outcome: "replaced",
      path: PATH,
      contentSha256: digest("remote"),
      sizeBytes: 6,
    });
    expect(host.process).toHaveBeenCalledTimes(1);
    expect(host.read).toHaveBeenCalledTimes(1);
  });

  it("refuses missing/folder targets and oversized replacement", async () => {
    const missing = new WriterHost();
    const writer = new ObsidianLocalReconciliationWriter(missing, cryptography);
    await expect(
      writer.replaceEligible(replaceRequest()),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.missingTarget,
    });
    missing.folder(PATH);
    await expect(
      writer.replaceEligible(replaceRequest()),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.destinationFolderExists,
    });
    missing.nodes.delete(PATH);
    missing.file(PATH, "local");
    const oversized = "x".repeat(MAX_NOTE_SIZE_BYTES + 1);
    await expect(
      writer.replaceEligible({
        ...replaceRequest(),
        replacementContent: oversized,
        replacementContentSha256: digest(oversized),
      }),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.oversized,
    });
    expect(missing.process).not.toHaveBeenCalled();
  });

  it("refuses a concurrent callback change without writing, even when the digest provider collides", async () => {
    const host = new WriterHost();
    const file = host.file(PATH, "local");
    host.process.mockImplementationOnce(async (_file, update) => {
      update("different local");
      return file.content;
    });
    const collidingCryptography: LocalReconciliationWriteCryptography = {
      hashContent: vi.fn(async () => digest("local")),
    };
    const writer = new ObsidianLocalReconciliationWriter(
      host,
      collidingCryptography,
    );
    await expect(
      writer.replaceEligible({
        ...replaceRequest("local", "replacement"),
        expectedContentSha256: digest("local"),
        replacementContentSha256: digest("local"),
      }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: LOCAL_RECONCILIATION_REFUSAL.staleContent,
    });
    expect(file.content).toBe("local");
  });

  it("refuses a target rename/replacement observed inside the atomic callback", async () => {
    const host = new WriterHost();
    const file = host.file(PATH, "local");
    host.process.mockImplementationOnce(async (_file, update) => {
      host.nodes.delete(PATH);
      file.content = update(file.content);
      return file.content;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(host, cryptography).replaceEligible(
        replaceRequest(),
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: LOCAL_RECONCILIATION_REFUSAL.staleContent,
    });
    expect(file.content).toBe("local");
  });

  it("classifies process throws and post-process reread mismatches as unknown", async () => {
    const processHost = new WriterHost();
    processHost.file(PATH, "local");
    processHost.process.mockRejectedValueOnce(new Error("host failure"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        processHost,
        cryptography,
      ).replaceEligible(replaceRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });

    const mismatchHost = new WriterHost();
    mismatchHost.file(PATH, "local");
    mismatchHost.read.mockResolvedValueOnce("successor");
    await expect(
      new ObsidianLocalReconciliationWriter(
        mismatchHost,
        cryptography,
      ).replaceEligible(replaceRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "postcondition-mismatch",
      effect: "unknown",
    });
  });

  it("reports replace lookup and recovery reread failures before a new process dispatch", async () => {
    const lookupHost = new WriterHost();
    lookupHost.lookup.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        lookupHost,
        cryptography,
      ).replaceEligible(replaceRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const recoveryHost = new WriterHost();
    recoveryHost.file(PATH, "remote");
    recoveryHost.read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        recoveryHost,
        cryptography,
      ).replaceEligible({
        ...replaceRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });
    expect(recoveryHost.process).not.toHaveBeenCalled();
  });

  it("same-operation recovery adopts only exact replacement bytes", async () => {
    const host = new WriterHost();
    host.file(PATH, "remote");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(
      writer.replaceEligible({
        ...replaceRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({ kind: "confirmed", outcome: "adopted" });
    expect(host.process).not.toHaveBeenCalled();
  });
});

describe("ObsidianLocalReconciliationWriter.createPreservation", () => {
  it("creates fixed parent folders and exact generated side content", async () => {
    const host = new WriterHost();
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    const expectedPath = `.ai-bridge-conflicts/${OPERATION}/local.md`;
    await expect(
      writer.createPreservation(preservationRequest()),
    ).resolves.toEqual({
      kind: "confirmed",
      outcome: "created",
      path: expectedPath,
      contentSha256: digest("competitor"),
      sizeBytes: 10,
    });
    expect(host.createFolder.mock.calls).toEqual([
      [".ai-bridge-conflicts"],
      [`.ai-bridge-conflicts/${OPERATION}`],
    ]);
    expect(host.create).toHaveBeenCalledExactlyOnceWith(
      expectedPath,
      "competitor",
    );
    expect(evaluateLocalNotePath(expectedPath, host.policy)).toMatchObject({
      kind: LocalInspectionKind.failed,
      reason: LocalSkipReason.excludedLocation,
    });
  });

  it.each(["root-file", "operation-folder", "side-file", "side-folder"])(
    "fails closed for %s collision",
    async (collision) => {
      const host = new WriterHost();
      const operationFolder = `.ai-bridge-conflicts/${OPERATION}`;
      const sidePath = `${operationFolder}/local.md`;
      if (collision === "root-file") host.file(".ai-bridge-conflicts", "x");
      if (collision !== "root-file") host.folder(".ai-bridge-conflicts");
      if (collision === "operation-folder") host.folder(operationFolder);
      if (collision === "side-file") {
        host.folder(operationFolder);
        host.file(sidePath, "competitor");
      }
      if (collision === "side-folder") {
        host.folder(operationFolder);
        host.folder(sidePath);
      }
      const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
      await expect(
        writer.createPreservation(preservationRequest()),
      ).resolves.toMatchObject({
        kind: "refused",
        reason: LOCAL_RECONCILIATION_REFUSAL.preservationCollision,
      });
      expect(host.create).not.toHaveBeenCalled();
    },
  );

  it("allows only same-operation exact recovery adoption", async () => {
    const host = new WriterHost();
    const operationFolder = `.ai-bridge-conflicts/${OPERATION}`;
    host.folder(".ai-bridge-conflicts");
    host.folder(operationFolder);
    host.file(`${operationFolder}/local.md`, "competitor");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(
      writer.createPreservation({
        ...preservationRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({ kind: "confirmed", outcome: "adopted" });
    host.file(`${operationFolder}/local.md`, "unrelated");
    await expect(
      writer.createPreservation({
        ...preservationRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: LOCAL_RECONCILIATION_REFUSAL.preservationCollision,
    });
  });

  it("classifies preservation lookup, folder creation, side creation, and recovery-read failures conservatively", async () => {
    const rootLookup = new WriterHost();
    rootLookup.lookup.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        rootLookup,
        cryptography,
      ).createPreservation(preservationRequest()),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const folderFailure = new WriterHost();
    folderFailure.createFolder.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        folderFailure,
        cryptography,
      ).createPreservation(preservationRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });

    const sideFailure = new WriterHost();
    sideFailure.folder(".ai-bridge-conflicts");
    sideFailure.create.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        sideFailure,
        cryptography,
      ).createPreservation(preservationRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });

    const recoveryFailure = new WriterHost();
    const operationFolder = `.ai-bridge-conflicts/${OPERATION}`;
    recoveryFailure.folder(".ai-bridge-conflicts");
    recoveryFailure.folder(operationFolder);
    recoveryFailure.file(`${operationFolder}/local.md`, "competitor");
    recoveryFailure.read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      new ObsidianLocalReconciliationWriter(
        recoveryFailure,
        cryptography,
      ).createPreservation({
        ...preservationRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });
  });

  it("fails closed when preservation side lookup or folder post-verification becomes unavailable", async () => {
    const sideLookup = new WriterHost();
    sideLookup.folder(".ai-bridge-conflicts");
    sideLookup.folder(`.ai-bridge-conflicts/${OPERATION}`);
    sideLookup.lookup.mockImplementation((path) => {
      if (path.endsWith("/local.md")) throw new Error("unavailable");
      return sideLookup.nodes.get(path) ?? null;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        sideLookup,
        cryptography,
      ).createPreservation({
        ...preservationRequest(),
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      effect: "definitely-refused",
    });

    const folderVerify = new WriterHost();
    let rootLookups = 0;
    folderVerify.lookup.mockImplementation((path) => {
      if (path === ".ai-bridge-conflicts") {
        rootLookups += 1;
        if (rootLookups === 2) throw new Error("ambiguous");
      }
      return folderVerify.nodes.get(path) ?? null;
    });
    await expect(
      new ObsidianLocalReconciliationWriter(
        folderVerify,
        cryptography,
      ).createPreservation(preservationRequest()),
    ).resolves.toMatchObject({ kind: "failed", effect: "unknown" });
  });

  it("does not reuse another operation artifact or interpolate source paths", async () => {
    const host = new WriterHost();
    host.folder(".ai-bridge-conflicts");
    host.folder(`.ai-bridge-conflicts/${OTHER_OPERATION}`);
    host.file(`.ai-bridge-conflicts/${OTHER_OPERATION}/local.md`, "competitor");
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    const result = await writer.createPreservation(preservationRequest());
    expect(result).toMatchObject({ kind: "confirmed" });
    expect(host.create.mock.calls[0]?.[0]).toBe(
      `.ai-bridge-conflicts/${OPERATION}/local.md`,
    );
    expect(host.create.mock.calls[0]?.[0]).not.toContain("notes/target.md");
  });

  it.each([".ai-bridge-conflicts", ".ai-bridge-conflicts/settings"])(
    "protects overlapping config subtree %s",
    async (configDirectory) => {
      const host = new WriterHost(configDirectory);
      await expect(
        new ObsidianLocalReconciliationWriter(
          host,
          cryptography,
        ).createPreservation(preservationRequest()),
      ).resolves.toMatchObject({
        kind: "refused",
        reason: LOCAL_RECONCILIATION_REFUSAL.unsafePreservationRoot,
      });
      expect(host.createFolder).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed operation/side input so traversal cannot shape the generated path", async () => {
    const host = new WriterHost();
    const writer = new ObsidianLocalReconciliationWriter(host, cryptography);
    await expect(
      writer.createPreservation({
        ...preservationRequest(),
        operationId: "../escape" as MirrorOperationId,
      }),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.unsafePreservationRoot,
    });
    await expect(
      writer.createPreservation({
        ...preservationRequest(),
        side: "../../escape" as typeof RECONCILIATION_PRESERVATION_SIDE.local,
      }),
    ).resolves.toMatchObject({
      reason: LOCAL_RECONCILIATION_REFUSAL.unsafePreservationRoot,
    });
    expect(host.create).not.toHaveBeenCalled();
  });
});
