import {
  isSyncDemoContent,
  type SyncDemoLocal,
  type SyncDemoLocalObservation,
  type SyncNotePath,
  type SyncRevision,
} from "@obsidian-ai-bridge/core";
import { syncDemoClientPathSchema } from "@obsidian-ai-bridge/protocol";
import { TFile, TFolder, type Vault } from "obsidian";

/** Official saved-file capabilities only; no raw adapter, delete, rename, cached read or editor buffer. */
type DemoVault = Pick<
  Vault,
  | "configDir"
  | "getAllLoadedFiles"
  | "getAbstractFileByPath"
  | "read"
  | "create"
  | "createFolder"
  | "process"
>;
/** A refused local capability never authorizes overwriting a competing file. */
class DemoLocalRefusal extends Error {
  /** Sanitizes failures without retaining paths or content in the error. */
  constructor() {
    super("Demo local admission refused.");
  }
}
/** Official Vault adapter with fresh complete metadata preflight and dispatch-time session fencing. */
export class DemoLocal implements SyncDemoLocal {
  /** Binds the saved-vault surface to the retained owner's current execution lease. */
  constructor(
    private readonly vault: DemoVault,
    private readonly allowed: () => boolean,
  ) {}
  /** Returns fresh saved bytes only after complete path/ancestor metadata checks before and after the read.
   * @returns Saved live bytes, positive absence or blocked observation, never inferred deletion.
   */
  async observe(path: SyncNotePath): Promise<SyncDemoLocalObservation> {
    try {
      if (
        !syncDemoClientPathSchema.safeParse(path).success ||
        !this.admit(path)
      )
        return { kind: "blocked" };
      const file = this.vault.getAbstractFileByPath(path);
      if (file === null) return { kind: "absent" };
      if (!(file instanceof TFile)) return { kind: "blocked" };
      const content = await this.vault.read(file);
      return this.admit(path) &&
        this.vault.getAbstractFileByPath(path) === file &&
        isSyncDemoContent(content)
        ? { kind: "live", content }
        : { kind: "blocked" };
    } catch {
      return { kind: "blocked" };
    }
  }
  /** Creates only absent targets or compares exact ACK bytes inside official process; exceptions retain effect uncertainty.
   * @returns Applied only after exact postcondition; refusal never overwrites and unknown requires prepared recovery.
   */
  async apply(
    path: SyncNotePath,
    expected: string | null,
    content: string,
  ): Promise<"applied" | "refused" | "unknown"> {
    if (
      !syncDemoClientPathSchema.safeParse(path).success ||
      !isSyncDemoContent(content) ||
      !this.admit(path)
    )
      return "refused";
    const node = this.vault.getAbstractFileByPath(path);
    if (expected === null && node !== null) return "refused";
    if (expected !== null && !(node instanceof TFile)) return "refused";
    try {
      if (expected === null) {
        await this.folders(path);
        if (
          !this.admit(path) ||
          this.vault.getAbstractFileByPath(path) !== null
        )
          return "refused";
        await this.vault.create(path, content);
      } else if (node instanceof TFile) {
        let matched = false;
        await this.vault.process(node, (saved) => {
          matched =
            this.admit(path) &&
            this.vault.getAbstractFileByPath(path) === node &&
            saved === expected;
          return matched ? content : saved;
        });
        if (!matched) return "refused";
      }
      const saved = await this.observe(path);
      return saved.kind === "live" && saved.content === content
        ? "applied"
        : "unknown";
    } catch {
      return "unknown";
    }
  }
  /** Creates the deterministic excluded copy without replacement; identical saved bytes make repeated verification idempotent. */
  async preserve(
    path: SyncNotePath,
    revision: SyncRevision,
    content: string,
  ): Promise<void> {
    if (
      !syncDemoClientPathSchema.safeParse(path).success ||
      !isSyncDemoContent(content)
    )
      throw new DemoLocalRefusal();
    const target = this.copyPath(path, revision);
    if (!this.admit(target)) throw new DemoLocalRefusal();
    const node = this.vault.getAbstractFileByPath(target);
    if (node !== null) {
      if (
        node instanceof TFile &&
        (await this.preserved(path, revision)) === content
      )
        return;
      throw new DemoLocalRefusal();
    }
    await this.folders(target);
    if (
      !this.admit(target) ||
      this.vault.getAbstractFileByPath(target) !== null
    )
      throw new DemoLocalRefusal();
    await this.vault.create(target, content);
    if ((await this.preserved(path, revision)) !== content)
      throw new DemoLocalRefusal();
  }
  /** Rechecks the same excluded tuple after saved reads; no foreign/colliding copy can become a preservation receipt.
   * @returns Exact saved competing bytes or null when unavailable/refused, never optimistic verification.
   */
  async preserved(
    path: SyncNotePath,
    revision: SyncRevision,
  ): Promise<string | null> {
    const target = this.copyPath(path, revision);
    if (!this.admit(target)) return null;
    const file = this.vault.getAbstractFileByPath(target);
    if (!(file instanceof TFile)) return null;
    const content = await this.vault.read(file);
    return this.admit(target) &&
      this.vault.getAbstractFileByPath(target) === file &&
      isSyncDemoContent(content)
      ? content
      : null;
  }
  /** Names one excluded copy by immutable remote revision and admitted literal target, never user-supplied arbitrary output.
   * @returns Deterministic excluded path for this original target/version tuple.
   */
  private copyPath(path: SyncNotePath, revision: SyncRevision): string {
    return `ai-bridge-conflicts/${revision}/${path}`;
  }
  /** Requires current session, exact canonical metadata and no folded target/ancestor aliases, file ancestors or host-config paths.
   * @param path Validated target or generated excluded-copy path.
   * @returns Whether the complete fresh metadata view admits dispatch, never authority from mtime.
   */
  private admit(path: string): boolean {
    if (!this.allowed()) return false;
    const config = this.vault.configDir.toLowerCase();
    const folded = path.toLowerCase();
    if (folded === config || folded.startsWith(`${config}/`)) return false;
    const parts = path.split("/");
    const parents = parts
      .slice(0, -1)
      .map((_part, index) => parts.slice(0, index + 1).join("/"));
    const names = [path, ...parents];
    const nodes = this.vault.getAllLoadedFiles();
    for (const name of names) {
      const matching = nodes.filter(
        (node) =>
          node.path.normalize("NFC").toLowerCase() === name.toLowerCase(),
      );
      if (matching.length > 1 || matching.some((node) => node.path !== name))
        return false;
      const node = matching[0];
      if (name === path && node !== undefined && !(node instanceof TFile))
        return false;
      if (name !== path && node !== undefined && !(node instanceof TFolder))
        return false;
      if ((this.vault.getAbstractFileByPath(name) ?? null) !== (node ?? null))
        return false;
    }
    return this.allowed();
  }
  /** Builds only canonical absent ancestors, rechecking session and whole metadata immediately before each official creation.
   * @param path Admitted target whose missing ancestors alone may be created.
   */
  private async folders(path: string): Promise<void> {
    const parts = path.split("/");
    for (const [index] of parts.slice(0, -1).entries()) {
      if (!this.admit(path)) throw new DemoLocalRefusal();
      const parent = parts.slice(0, index + 1).join("/");
      if (this.vault.getAbstractFileByPath(parent) === null)
        await this.vault.createFolder(parent);
    }
  }
}
