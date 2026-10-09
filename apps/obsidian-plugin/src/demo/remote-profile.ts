import {
  isSyncRemoteEndpoint,
  SYNC_REMOTE_MODE,
  SYNC_REMOTE_TICKETS,
} from "@obsidian-ai-bridge/protocol";
import {
  type DemoConfig,
  type DemoProfile,
  readDemoString,
} from "@obsidian-plugin/demo/demo-config";
import type { App } from "obsidian";

/** Strict remote artifact state/transport authority; no local-demo configuration or owner is reused. */
export const REMOTE_DEMO_PROFILE: DemoProfile = {
  mode: SYNC_REMOTE_MODE,
  configKey: "ai-bridge:synthetic-remote:configuration:v1",
  ownerSymbol: Symbol.for("obsidian-ai-bridge.synthetic-remote.owner.v1"),
  ledgerPrefix: "ai-bridge:synthetic-remote:ledger:v1",
  secretReference: "remote-native-secret",
  endpoint: "https://replace-with-approved-host.invalid",
  admitsEndpoint: isSyncRemoteEndpoint,
  ticket: nextRemoteTicket,
};
/** Persists the next participant-local slot before Fetch with exact read-back; ambiguous/corrupt/exhausted state never resets or refunds.
 * @param app Official App-local string persistence, not a vault file or bearer store.
 * @param config Original strictly armed remote namespace/participant binding.
 * @returns Fresh consumed slot, or null when state cannot authorize another Fetch.
 */
export function nextRemoteTicket(
  app: Pick<App, "loadLocalStorage" | "saveLocalStorage">,
  config: DemoConfig,
): string | null {
  if (config.mode !== SYNC_REMOTE_MODE || config.experimentId === undefined)
    return null;
  const key = `ai-bridge:synthetic-remote:tickets:v1:${config.experimentId}:${config.vaultId}:${config.deviceId}`;
  try {
    const stored = readDemoString(app, key);
    if (
      stored !== null &&
      (stored.length > String(SYNC_REMOTE_TICKETS).length ||
        !/^(0|[1-9][0-9]*)$/.test(stored))
    )
      return null;
    const next = stored === null ? 0 : Number(stored);
    if (next >= SYNC_REMOTE_TICKETS) return null;
    const value = String(next + 1);
    app.saveLocalStorage(key, value);
    return readDemoString(app, key) === value ? String(next) : null;
  } catch {
    return null;
  }
}
