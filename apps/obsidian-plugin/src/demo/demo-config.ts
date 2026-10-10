import type { SyncDemoClientOutcome } from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_DEMO_PATHS,
  SYNC_DEMO_LOOPBACK_HOSTS,
  SYNC_DEMO_URL_PROTOCOL,
  SYNC_REMOTE_MODE,
  syncDemoClientPathSchema,
  syncDeviceIdSchema,
  syncOperationIdSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";
import { z } from "zod";

/** Closed local presentation categories; coordinator outcomes remain defined by the core contract. */
export const DEMO_PRESENTATION = {
  notArmed: "Not armed",
  ready: "Ready",
  syncing: "Syncing",
  automaticDisableUnverified:
    "Automatic disable unverified. Close Obsidian; a full restart may resume if the old opt-in remains.",
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
    mode: z.enum(["synthetic-local-only", SYNC_REMOTE_MODE]),
    endpoint: z.string(),
    experimentId: syncOperationIdSchema.optional(),
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
/** Transport/state capability selected only by the artifact entrypoint; local defaults never admit remote arming. */
export interface DemoProfile {
  /** Closed arming mode for this artifact, never selected by note content. */
  readonly mode: DemoConfig["mode"];
  /** Independent host-local configuration slot; does not migrate another profile. */
  readonly configKey: string;
  /** Same-App owner namespace retaining dispatch exclusion across bundle replacement. */
  readonly ownerSymbol: symbol;
  /** Content-free ledger namespace, combined with experiment/vault/device identities. */
  readonly ledgerPrefix: string;
  /** Default non-secret native selector, never an existing token. */
  readonly secretReference: string;
  /** Unarmed draft endpoint; successful configuration pins its exact authority. */
  readonly endpoint: string;
  /** Validates only the profile's endpoint syntax; retained configuration pins its exact original origin. */
  readonly admitsEndpoint: (value: string) => boolean;
  /** Remote-only, durable pre-dispatch admission; a missing or exhausted ticket closes Fetch. */
  readonly ticket?: (app: App, config: DemoConfig) => string | null;
  /** Separate durable opt-in slot; absent for the local demo artifact. */
  readonly automaticKey?: string;
  /** Remote admission state checked before each scheduled wake. */
  readonly automaticAvailable?: (app: App, config: DemoConfig) => boolean;
}
/** Artifact-selected local profile maintains original config/owner/ledger keys and loopback-only admission. */
export const LOCAL_DEMO_PROFILE: DemoProfile = {
  mode: "synthetic-local-only",
  configKey: DEMO_CONFIG_KEY,
  ownerSymbol: DEMO_OWNER_SYMBOL,
  ledgerPrefix: "ai-bridge:synthetic-demo:ledger:v1",
  secretReference: "demo-native-secret",
  endpoint: "http://127.0.0.1:8789",
  admitsEndpoint: isDemoEndpoint,
};
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
 * @param profile Artifact-selected transport/state authority; defaults retain the local-only contract.
 * @returns Exact armed configuration or null without normalization/reset.
 */
export function decodeDemoConfig(
  value: unknown,
  profile: DemoProfile = LOCAL_DEMO_PROFILE,
): DemoConfig | null {
  if (
    typeof value !== "string" ||
    value.length > CONFIG_BYTES ||
    new TextEncoder().encode(value).byteLength > CONFIG_BYTES
  )
    return null;
  try {
    const parsed = configSchema.safeParse(JSON.parse(value));
    if (
      !parsed.success ||
      parsed.data.mode !== profile.mode ||
      !profile.admitsEndpoint(parsed.data.endpoint)
    )
      return null;
    if (
      profile.mode === SYNC_REMOTE_MODE
        ? parsed.data.experimentId === undefined
        : parsed.data.experimentId !== undefined
    )
      return null;
    return parsed.data;
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
export function demoLedgerKey(
  config: DemoConfig,
  profile: DemoProfile = LOCAL_DEMO_PROFILE,
): string {
  return `${profile.ledgerPrefix}:${config.experimentId ? `${config.experimentId}:` : ""}${config.vaultId}:${config.deviceId}`;
}
