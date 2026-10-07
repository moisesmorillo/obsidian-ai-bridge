import type { SyncDemoClientOutcome } from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_DEMO_PATHS,
  SYNC_DEMO_LOOPBACK_HOSTS,
  SYNC_DEMO_URL_PROTOCOL,
  syncDemoClientPathSchema,
  syncDeviceIdSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";
import { z } from "zod";

/** Closed local presentation categories; coordinator outcomes remain defined by the core contract. */
export const DEMO_PRESENTATION = {
  notArmed: "Not armed",
  ready: "Ready",
  syncing: "Syncing",
} as const;
/** Trusted text-only categories; user/remote data cannot become a status. */
export type DemoPresentation =
  | SyncDemoClientOutcome
  | (typeof DEMO_PRESENTATION)[keyof typeof DEMO_PRESENTATION];
/** Host-local configuration key, deliberately separate from plugin data.json and all release ledgers. */
export const DEMO_CONFIG_KEY = "ai-bridge:synthetic-demo:configuration:v1";
/** Explicit disposable-data acknowledgement; it is not permission to connect an existing personal vault. */
export const DEMO_ACKNOWLEDGEMENT = "DISPOSABLE SYNTHETIC VAULT";
/** Independent experimental plugin identity; never the release ai-bridge ID. */
export const DEMO_PLUGIN_ID = "ai-bridge-synthetic-demo";
/** Compatible same-JS-realm registry; this is not a cross-process or distributed lock. */
export const DEMO_OWNER_SYMBOL = Symbol.for(
  "obsidian-ai-bridge.synthetic-demo.owner.v1",
);
/** Bounds untrusted local configuration before JSON parsing, in UTF-8 bytes. */
const CONFIG_BYTES = 4096;
/** Strict explicit arming/binding; only a native-secret reference, never a bearer or note body. */
const configSchema = z
  .object({
    mode: z.literal("synthetic-local-only"),
    endpoint: z.string().refine(isDemoEndpoint),
    vaultId: syncVaultIdSchema,
    deviceId: syncDeviceIdSchema,
    paths: z.array(syncDemoClientPathSchema).min(1).max(MAX_SYNC_DEMO_PATHS),
    secretReference: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    acknowledgement: z.literal(DEMO_ACKNOWLEDGEMENT),
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.paths.map((path) => path.toLowerCase())).size ===
      config.paths.length,
  );
/** Validated local authority for one disposable namespace and immutable ordered target set. */
export type DemoConfig = z.infer<typeof configSchema>;
/** Checks exact loopback HTTP base origins without credentials, path, query or fragment; no network resolution occurs.
 * @param value Non-secret configured origin, never note text.
 * @returns Whether the exact synthetic transport contract admits this origin.
 */
function isDemoEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === SYNC_DEMO_URL_PROTOCOL &&
      SYNC_DEMO_LOOPBACK_HOSTS.some((host) => host === url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
/** Isolates weak official App-local input and immediately converts bounded strict JSON to strong configuration, without repair.
 * @param value Untrusted host-local string or malformed boundary value.
 * @returns Exact armed configuration or null without normalization/reset.
 */
export function decodeDemoConfig(value: unknown): DemoConfig | null {
  if (
    typeof value !== "string" ||
    value.length > CONFIG_BYTES ||
    new TextEncoder().encode(value).byteLength > CONFIG_BYTES
  )
    return null;
  try {
    const parsed = configSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** Reads only a positively absent or exact string at the official host-local boundary; unavailable/non-string state is never absence.
 * @returns Observed absence or exact persisted string; throws on unreadable/non-string state.
 */
export function readDemoString(
  app: Pick<App, "loadLocalStorage">,
  key: string,
): string | null {
  const value: unknown = app.loadLocalStorage(key);
  if (value === null) return null;
  if (typeof value !== "string")
    throw new TypeError("Unavailable demo local state.");
  return value;
}
/** Stable host-local ledger slot bound to the original namespace and participant, never synced into Vault content.
 * @returns Versioned slot for the original vault/device binding.
 */
export function demoLedgerKey(config: DemoConfig): string {
  return `ai-bridge:synthetic-demo:ledger:v1:${config.vaultId}:${config.deviceId}`;
}
