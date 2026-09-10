import type { Identifier } from "@obsidian-ai-bridge/core";
import type { ProtocolEnvelope } from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";

/**
 * Placeholder dependency surface for the future Obsidian adapter.
 *
 * M1 intentionally has no vault or network behavior; these optional members
 * reserve the shape without creating a persisted plugin-state contract.
 */
export interface PluginScaffold {
  /** Obsidian application instance supplied by the host when available. */
  readonly app?: App;

  /** Normalized identifier used by a future remote adapter. */
  readonly identifier?: Identifier;

  /** Shared protocol metadata reserved for future requests. */
  readonly envelope?: ProtocolEnvelope;
}
