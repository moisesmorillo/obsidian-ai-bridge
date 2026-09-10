import type { NotePath } from "@core/note-path/note-path.types";

/** Port implemented by storage adapters that persist normalized Markdown notes. */
export interface VaultRepository {
  list(): Promise<readonly NotePath[]>;
  exists(path: NotePath): Promise<boolean>;
  read(path: NotePath): Promise<string | null>;
  write(path: NotePath, content: string): Promise<void>;
  delete(path: NotePath): Promise<void>;
}
