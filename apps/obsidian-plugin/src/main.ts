import type { App } from "obsidian";
import type { Identifier } from "@obsidian-ai-bridge/core";
import type { ProtocolEnvelope } from "@obsidian-ai-bridge/protocol";

export interface PluginScaffold {
  readonly app?: App;
  readonly identifier?: Identifier;
  readonly envelope?: ProtocolEnvelope;
}
