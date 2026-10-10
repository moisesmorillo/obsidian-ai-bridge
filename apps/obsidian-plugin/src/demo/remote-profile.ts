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
  automaticKey: "ai-bridge:synthetic-remote:automatic:v1",
  automaticAvailable: remoteTicketsAvailable,
};
/** Selects only the original experiment and participant's ticket slot.
 * @param config Strict remote binding with an experiment identity.
 * @param experimentId Validated experiment identity from the remote config.
 * @returns Host-local ticket key for the original participant.
 */
function remoteTicketKey(config: DemoConfig, experimentId: string): string {
  return `ai-bridge:synthetic-remote:tickets:v1:${experimentId}:${config.vaultId}:${config.deviceId}`;
}
/** Decodes next ticket slot without treating corruption or exhaustion as fresh authority.
 * @param app Official local storage reader for this participant.
 * @param key Original participant's ticket slot.
 * @returns Next admissible slot or null when malformed or exhausted.
 */
function readNextRemoteTicket(
  app: Pick<App, "loadLocalStorage">,
  key: string,
): number | null {
  const stored = readDemoString(app, key);
  if (
    stored !== null &&
    (stored.length > String(SYNC_REMOTE_TICKETS).length ||
      !/^(0|[1-9][0-9]*)$/.test(stored))
  )
    return null;
  const next = stored === null ? 0 : Number(stored);
  return next < SYNC_REMOTE_TICKETS ? next : null;
}
/** Reads remaining one-use ticket authority without consuming a slot; invalid state closes automatic dispatch.
 * @param app Official local storage reader for this participant.
 * @param config Original remote binding.
 * @returns Whether at least one ticket remains with exact readable state.
 */
export function remoteTicketsAvailable(
  app: Pick<App, "loadLocalStorage">,
  config: DemoConfig,
): boolean {
  if (config.mode !== SYNC_REMOTE_MODE || config.experimentId === undefined)
    return false;
  try {
    return (
      readNextRemoteTicket(
        app,
        remoteTicketKey(config, config.experimentId),
      ) !== null
    );
  } catch {
    return false;
  }
}
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
  const key = remoteTicketKey(config, config.experimentId);
  try {
    const next = readNextRemoteTicket(app, key);
    if (next === null) return null;
    const value = String(next + 1);
    app.saveLocalStorage(key, value);
    return readDemoString(app, key) === value ? String(next) : null;
  } catch {
    return null;
  }
}
