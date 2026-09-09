import type { Identifier } from "@obsidian-ai-bridge/core";
import type { ProtocolEnvelope } from "@obsidian-ai-bridge/protocol";

export interface WorkerScaffold {
  readonly identifier?: Identifier;
  readonly envelope?: ProtocolEnvelope;
}

export type Env = Record<string, never>;
