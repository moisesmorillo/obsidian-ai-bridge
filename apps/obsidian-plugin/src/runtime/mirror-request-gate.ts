import {
  MAX_ACTIVE_MIRROR_JOBS,
  type RemoteRequestAdmission,
  type RemoteRequestPermit,
} from "@obsidian-ai-bridge/core";

/** Transport-owned cancellation registration used only at the plugin adapter boundary. */
export interface MirrorRequestCancellation {
  /** Registers one dispatched request until its real transport settlement. */
  register(controller: AbortController): () => void;
}

/**
 * Same-runtime request admission and cancellation owner.
 *
 * Closing the gate prevents new requests and asks active Fetch operations to abort,
 * but permits remain occupied until each underlying operation actually settles and
 * releases them. The gate stores no bearer, request body, response body, or host file.
 */
export class MirrorRequestGate
  implements RemoteRequestAdmission, MirrorRequestCancellation
{
  private open = false;
  private generation = 0;
  private activePermits = 0;
  private readonly controllers = new Set<AbortController>();

  /** Opens admission for a verified attached runtime session. */
  enable(): void {
    if (this.open) return;
    this.generation += 1;
    this.open = true;
  }

  /**
   * Closes new admission and requests safe client-side cancellation.
   * Remote effect certainty remains owned by the transport/core settlement path.
   */
  disable(): void {
    if (this.open) this.generation += 1;
    this.open = false;
    for (const controller of this.controllers) controller.abort();
  }

  /** @returns Number of operations whose real settlement still owns admission. */
  activeCount(): number {
    return this.activePermits;
  }

  /** @inheritdoc */
  async admit(): Promise<RemoteRequestPermit | undefined> {
    if (!this.open || this.activePermits >= MAX_ACTIVE_MIRROR_JOBS) {
      return undefined;
    }
    this.activePermits += 1;
    let released = false;
    const generation = this.generation;
    return {
      isCurrent: () => this.open && this.generation === generation,
      release: () => {
        if (released) return;
        released = true;
        this.activePermits -= 1;
      },
    };
  }

  /** @inheritdoc */
  register(controller: AbortController): () => void {
    this.controllers.add(controller);
    if (!this.open) controller.abort();
    return () => this.controllers.delete(controller);
  }
}
