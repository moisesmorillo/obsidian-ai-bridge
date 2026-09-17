import {
  blockMirrorPath,
  clearDesiredGeneration,
} from "@core/mirror/mirror-autosync-state";
import { MIRROR_PATH_BLOCK_REASON } from "@core/mirror/mirror-state.constants";
import type { MirrorPathBlockReason } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type { MirrorPathJobOutcome } from "@core/mirror/mirror-synchronizer.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Owns paired durable path status transitions and sanitized runtime outcomes. */
export class MirrorPathStatusWriter {
  /** Couples serialized ledger transitions to a content-free runtime outcome sink without owning retry policy. */
  constructor(
    private readonly stateOwner: MirrorStateOwner,
    private readonly setOutcome: (outcome: MirrorPathJobOutcome) => void,
  ) {}

  /** Records one runtime outcome without changing durable ledger state. */
  record(outcome: MirrorPathJobOutcome): void {
    this.setOutcome(outcome);
  }

  /** Clears only the positive generation settled by confirmed evidence. */
  async clearDesired(path: NotePath, generation: number): Promise<void> {
    await this.stateOwner.transition((state) =>
      clearDesiredGeneration(state, path, generation),
    );
  }

  /** Applies durable divergence plus the specific runtime outcome. */
  async blockDiverged(path: NotePath): Promise<void> {
    await this.block(path, MIRROR_PATH_BLOCK_REASON.diverged);
    this.setOutcome({ kind: "diverged", path });
  }

  /** Applies one durable terminal blocker and sanitized runtime outcome. */
  async block(path: NotePath, reason: MirrorPathBlockReason): Promise<void> {
    await this.stateOwner.transition((state) =>
      blockMirrorPath(state, path, reason),
    );
    this.setOutcome({ kind: "blocked", path });
  }
}
