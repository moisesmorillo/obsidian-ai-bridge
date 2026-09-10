import type { LocalInspector } from "@obsidian-ai-bridge/core";
import type { LocalInspectionUi } from "@obsidian-plugin/inspection/local-inspection-ui";

/** One enable lifetime; identity prevents a previous lifetime's results reaching new UI. */
export interface InspectionSession {
  readonly inspector: LocalInspector;
  readonly ui: LocalInspectionUi;
  /** Shared by both commands, never a domain failure or persistent state. */
  busy: boolean;
}
