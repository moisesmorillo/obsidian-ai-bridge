import type {
  ObsidianFile,
  ObsidianVaultHost,
} from "@obsidian-plugin/infrastructure/obsidian-vault-host.types";
import { vi } from "vitest";

/** Mutable host evidence and saved text, isolated from any filesystem or editor. */
export interface FakeFile extends ObsidianFile {
  path: string;
  stat: { size: number; mtime: number };
  content: string;
}

/**
 * Creates host evidence whose default size is the actual UTF-8 length.
 * @param path - Literal host name, deliberately allowed to be invalid.
 * @param content - Saved text returned by the fake read.
 * @param size - Optional misleading metadata for boundary tests.
 * @returns An identity-stable, mutable host file.
 */
export function fakeFile(
  path: string,
  content = "saved text",
  size = new TextEncoder().encode(content).byteLength,
): FakeFile {
  return { path, content, stat: { size, mtime: 1000 } };
}

/** Minimal host with observable access and explicit test-controlled race hooks. */
export class FakeVaultHost implements ObsidianVaultHost<FakeFile> {
  readonly files = new Map<string, FakeFile>();
  readonly getFiles = vi.fn((): readonly FakeFile[] => [
    ...this.files.values(),
  ]);
  readonly getFile = vi.fn(
    (path: string): FakeFile | null => this.files.get(path) ?? null,
  );
  readonly read = vi.fn(
    async (file: FakeFile): Promise<string> => file.content,
  );

  /**
   * Seeds saved files without invoking a product write capability.
   * @param files - Host records to make visible at exact names.
   * @param configDir - Exact host configuration directory for privacy tests.
   */
  constructor(
    files: readonly FakeFile[] = [],
    readonly configDir = "config",
  ) {
    for (const file of files) this.files.set(file.path, file);
  }
}
