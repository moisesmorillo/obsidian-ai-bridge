import type { Identifier } from "@obsidian-ai-bridge/core";
import type { ProtocolEnvelope } from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";

export interface PluginScaffold {
  readonly app?: App;
  readonly identifier?: Identifier;
  readonly envelope?: ProtocolEnvelope;
}
