import type { MirrorOrigin } from "@obsidian-ai-bridge/core";
import { validateMirrorEndpoint } from "@obsidian-plugin/configuration/mirror-endpoint";
import { z } from "zod";

/** Closed plugin-data format identifier; it never contains device-local authority. */
export const MIRROR_PREFERENCES_FORMAT = "obsidian-ai-bridge-preferences";

/** Current strict plugin-data schema version. */
export const MIRROR_PREFERENCES_VERSION = 1;

/** Maximum encoded plugin preferences size accepted by the boundary codec. */
export const MAX_MIRROR_PREFERENCES_BYTES = 64 * 1024;

/** Synced preferences and native secret reference; no writer activation or ledger exists here. */
export interface MirrorPreferences {
  readonly origin: MirrorOrigin | null;
  /** Exact canonical loopback HTTP origin whose development exception was approved. */
  readonly loopbackHttpOrigin: MirrorOrigin | null;
  readonly secretReference: string | null;
}

/** Strict plugin-data decode result preserving missing/corrupt/future distinctions. */
export type MirrorPreferencesDecodeResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly preferences: MirrorPreferences }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unsupported-version"; readonly version: number };

/** Narrow adapter seam around Plugin.loadData/saveData. */
export interface PluginDataHost {
  /** @returns Parsed host plugin data or null when it does not exist. */
  loadData(): Promise<unknown>;
  /** @param data - Closed serializable preferences record. */
  saveData(data: object): Promise<void>;
}

const secretReferenceSchema = z.string().min(1).max(128);
const preferencesSchema = z
  .object({
    format: z.literal(MIRROR_PREFERENCES_FORMAT),
    version: z.literal(MIRROR_PREFERENCES_VERSION),
    origin: z.string().max(2048).nullable(),
    loopbackHttpOrigin: z.string().max(2048).nullable(),
    secretReference: secretReferenceSchema.nullable(),
  })
  .strict();
const preferencesHeaderSchema = z
  .object({
    format: z.literal(MIRROR_PREFERENCES_FORMAT),
    version: z.number().int(),
  })
  .loose();

/**
 * Strictly decodes parsed plugin data without merging defaults into malformed input.
 *
 * @param value - Untrusted value returned by `Plugin.loadData`.
 * @returns Missing, valid, corrupt, or unsupported-future state.
 */
export function decodeMirrorPreferences(
  value: unknown,
): MirrorPreferencesDecodeResult {
  if (value === null || value === undefined) return { kind: "missing" };
  const encoded = safeStringify(value);
  if (
    encoded === undefined ||
    byteLength(encoded) > MAX_MIRROR_PREFERENCES_BYTES
  ) {
    return { kind: "corrupt" };
  }
  const header = preferencesHeaderSchema.safeParse(value);
  if (header.success && header.data.version > MIRROR_PREFERENCES_VERSION) {
    return { kind: "unsupported-version", version: header.data.version };
  }
  const decoded = preferencesSchema.safeParse(value);
  if (!decoded.success) return { kind: "corrupt" };
  const loopbackPermissionMatches =
    decoded.data.loopbackHttpOrigin !== null &&
    decoded.data.loopbackHttpOrigin === decoded.data.origin;
  if (
    decoded.data.loopbackHttpOrigin !== null &&
    (!loopbackPermissionMatches ||
      !decoded.data.loopbackHttpOrigin.startsWith("http://"))
  ) {
    return { kind: "corrupt" };
  }
  let origin: MirrorOrigin | null = null;
  if (decoded.data.origin !== null) {
    const parsedOrigin = validateMirrorEndpoint(
      decoded.data.origin,
      loopbackPermissionMatches,
    );
    if (
      parsedOrigin.kind !== "valid" ||
      parsedOrigin.origin !== decoded.data.origin
    ) {
      return { kind: "corrupt" };
    }
    origin = parsedOrigin.origin;
  }
  return {
    kind: "valid",
    preferences: {
      origin,
      loopbackHttpOrigin:
        decoded.data.loopbackHttpOrigin === null ? null : origin,
      secretReference: decoded.data.secretReference,
    },
  };
}

/**
 * Encodes only synced preferences and a native secret reference.
 *
 * @param preferences - Validated preference values.
 * @returns Closed data.json-compatible object containing no bearer or local ledger.
 * @throws When origin and loopback permission are inconsistent.
 */
export function encodeMirrorPreferences(
  preferences: MirrorPreferences,
): object {
  const loopbackPermissionMatches =
    preferences.loopbackHttpOrigin !== null &&
    preferences.loopbackHttpOrigin === preferences.origin;
  if (
    preferences.loopbackHttpOrigin !== null &&
    (!loopbackPermissionMatches ||
      !preferences.loopbackHttpOrigin.startsWith("http://"))
  ) {
    throw new Error(
      "Loopback HTTP permission is not bound to the exact HTTP origin.",
    );
  }
  if (preferences.origin !== null) {
    const endpoint = validateMirrorEndpoint(
      preferences.origin,
      loopbackPermissionMatches,
    );
    if (endpoint.kind !== "valid" || endpoint.origin !== preferences.origin) {
      throw new Error("Invalid mirror endpoint preferences.");
    }
  }
  const encoded = preferencesSchema.safeParse({
    format: MIRROR_PREFERENCES_FORMAT,
    version: MIRROR_PREFERENCES_VERSION,
    origin: preferences.origin,
    loopbackHttpOrigin: preferences.loopbackHttpOrigin,
    secretReference: preferences.secretReference,
  });
  if (!encoded.success) {
    throw new Error("Invalid mirror preference fields.");
  }
  return encoded.data;
}

/** Host adapter preserving typed failures without exposing raw exceptions. */
export class ObsidianPluginDataStore {
  /** @param host - Narrow official plugin-data capability. */
  constructor(private readonly host: PluginDataHost) {}

  /** @returns Strict decode outcome; failures are corrupt/unavailable, never defaults. */
  async load(): Promise<
    MirrorPreferencesDecodeResult | { readonly kind: "unavailable" }
  > {
    try {
      return decodeMirrorPreferences(await this.host.loadData());
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * @param preferences - Validated preferences only.
   * @returns Sanitized save outcome.
   */
  async save(
    preferences: MirrorPreferences,
  ): Promise<{ readonly kind: "saved" } | { readonly kind: "failed" }> {
    try {
      await this.host.saveData(encodeMirrorPreferences(preferences));
      return { kind: "saved" };
    } catch {
      return { kind: "failed" };
    }
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
