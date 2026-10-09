import DemoPlugin from "@obsidian-plugin/demo/demo-main";
import { REMOTE_DEMO_PROFILE } from "@obsidian-plugin/demo/remote-profile";

/** Separate remote-only experimental artifact; reuses local safety without admitting local state or activating release mirroring. */
export default class RemoteDemoPlugin extends DemoPlugin {
  /** Immutable artifact capability; endpoint/namespace/reference are pinned by original verified configuration. */
  protected override readonly profile = REMOTE_DEMO_PROFILE;
}
