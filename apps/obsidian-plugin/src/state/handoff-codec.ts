import {
  type ContentSha256,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createRecoverySnapshotId,
  type HandoffBaselineEntry,
  type HandoffPayload,
  type HandoffRecord,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  normalizeNotePath,
  type TransferableAcknowledgement,
} from "@obsidian-ai-bridge/core";
import { parsePersistedMirrorOrigin } from "@obsidian-plugin/configuration/mirror-endpoint";
import { z } from "zod";

/** Closed user-controlled handoff record format. */
export const HANDOFF_RECORD_FORMAT = "obsidian-ai-bridge-handoff";

/** Current strict handoff format version. */
export const HANDOFF_RECORD_VERSION = 1;

/** Maximum content-free handoff record size. */
export const MAX_HANDOFF_RECORD_BYTES = 8 * 1024 * 1024;

/** Cryptographic integrity seam for deterministic handoff codec tests. */
export interface HandoffIntegrity {
  /**
   * @param canonicalPayload - Stable content-free payload serialization.
   * @returns Canonical lowercase SHA-256 digest.
   */
  digest(canonicalPayload: string): Promise<ContentSha256>;
}

/** Strict handoff import result; invalid/future records never become staged state. */
export type HandoffDecodeResult =
  | { readonly kind: "valid"; readonly record: HandoffRecord }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unsupported-version"; readonly version: number }
  | { readonly kind: "integrity-mismatch" };

const transferableAcknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.live),
      revision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone),
      revision: z.string(),
      recoveryId: z.string(),
    })
    .strict(),
]);
const handoffRecordSchema = z
  .object({
    format: z.literal(HANDOFF_RECORD_FORMAT),
    version: z.literal(HANDOFF_RECORD_VERSION),
    origin: z.string().min(1).max(2048),
    associationId: z.string(),
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            acknowledgement: transferableAcknowledgementSchema,
          })
          .strict(),
      )
      .max(MAX_MIRROR_TRACKED_PATHS),
    checksum: z.string(),
  })
  .strict()
  .superRefine((record, context) => {
    const paths = record.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "Duplicate handoff path." });
    }
  });
const handoffHeaderSchema = z
  .object({
    format: z.literal(HANDOFF_RECORD_FORMAT),
    version: z.number().int(),
  })
  .loose();

type HandoffRecordDto = z.infer<typeof handoffRecordSchema>;
type TransferableAcknowledgementDto = z.infer<
  typeof transferableAcknowledgementSchema
>;

/** Web Crypto SHA-256 implementation; it stores and returns no plaintext note data. */
export class WebCryptoHandoffIntegrity implements HandoffIntegrity {
  /** @param cryptography - Standards Web Crypto provider from the supported host. */
  constructor(private readonly cryptography: Crypto = globalThis.crypto) {}

  /** @inheritdoc */
  async digest(canonicalPayload: string): Promise<ContentSha256> {
    const digest = await this.cryptography.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalPayload),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const validated = createContentSha256(hex);
    if (validated === undefined)
      throw new Error("Invalid SHA-256 provider output.");
    return validated;
  }
}

/**
 * Creates a checksum-covered content-free record from a quiescent core payload.
 *
 * @param payload - Association/origin and transferable acknowledgements only.
 * @param integrity - Injected SHA-256 capability.
 * @returns Canonically ordered handoff record.
 */
export async function createHandoffRecord(
  payload: HandoffPayload,
  integrity: HandoffIntegrity,
): Promise<HandoffRecord> {
  const canonical = canonicalPayload(payload);
  return {
    origin: canonical.payload.origin,
    associationId: canonical.payload.associationId,
    entries: canonical.payload.entries,
    checksum: await integrity.digest(canonical.text),
  };
}

/**
 * Encodes a handoff record without device identity, activation, secrets, preferences,
 * unresolved work, or note bodies.
 *
 * @param record - Verified content-free handoff metadata.
 * @returns Canonical bounded JSON transfer text.
 * @throws When the record is inconsistent or exceeds the practical bound.
 */
export function encodeHandoffRecord(record: HandoffRecord): string {
  const canonical = canonicalPayload(record);
  if (createContentSha256(record.checksum) !== record.checksum) {
    throw new Error("Invalid handoff checksum.");
  }
  const encoded = JSON.stringify({
    format: HANDOFF_RECORD_FORMAT,
    version: HANDOFF_RECORD_VERSION,
    origin: canonical.payload.origin,
    associationId: canonical.payload.associationId,
    entries: canonical.payload.entries,
    checksum: record.checksum,
  });
  if (byteLength(encoded) > MAX_HANDOFF_RECORD_BYTES) {
    throw new Error("Handoff record exceeds the size bound.");
  }
  return encoded;
}

/**
 * Strictly decodes and verifies explicit user-controlled handoff text.
 *
 * @param encoded - Untrusted handoff JSON.
 * @param integrity - Injected SHA-256 capability.
 * @returns Valid record or a closed refusal preserving future/corrupt distinction.
 */
export async function decodeHandoffRecord(
  encoded: string,
  integrity: HandoffIntegrity,
): Promise<HandoffDecodeResult> {
  if (byteLength(encoded) > MAX_HANDOFF_RECORD_BYTES)
    return { kind: "corrupt" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return { kind: "corrupt" };
  }
  const header = handoffHeaderSchema.safeParse(parsed);
  if (header.success && header.data.version > HANDOFF_RECORD_VERSION) {
    return { kind: "unsupported-version", version: header.data.version };
  }
  const decoded = handoffRecordSchema.safeParse(parsed);
  if (!decoded.success) return { kind: "corrupt" };
  let record: HandoffRecord;
  try {
    record = convertRecord(decoded.data);
  } catch {
    return { kind: "corrupt" };
  }
  const canonical = canonicalPayload(record);
  const expected = await integrity.digest(canonical.text);
  if (expected !== record.checksum) return { kind: "integrity-mismatch" };
  return {
    kind: "valid",
    record: {
      origin: canonical.payload.origin,
      associationId: canonical.payload.associationId,
      entries: canonical.payload.entries,
      checksum: record.checksum,
    },
  };
}

/**
 * Verifies the checksum covering transferable baseline fields only.
 *
 * @param payload - Persisted or imported baseline without staging evidence.
 * @param checksum - Expected canonical payload digest.
 * @param integrity - Adapter-owned digest capability.
 * @returns Whether the exact projected baseline retains its original integrity.
 */
export async function verifyHandoffPayloadChecksum(
  payload: HandoffPayload,
  checksum: ContentSha256,
  integrity: HandoffIntegrity,
): Promise<boolean> {
  const canonical = canonicalPayload(payload);
  return (await integrity.digest(canonical.text)) === checksum;
}

function canonicalPayload(payload: HandoffPayload): {
  readonly payload: HandoffPayload;
  readonly text: string;
} {
  if (payload.entries.length > MAX_MIRROR_TRACKED_PATHS) {
    throw new Error("Handoff record exceeds the path bound.");
  }
  const origin = requireExactParsed(
    payload.origin,
    parsePersistedMirrorOrigin,
    "origin",
  );
  const associationId = requireExactParsed(
    payload.associationId,
    createMirrorAssociationId,
    "association",
  );
  const entries = payload.entries
    .map(
      (entry): HandoffBaselineEntry => ({
        path: requireExactParsed(entry.path, normalizeNotePath, "path"),
        acknowledgement: projectAcknowledgement(entry.acknowledgement),
      }),
    )
    .sort((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      return 0;
    });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Duplicate handoff path.");
  }
  const canonical: HandoffPayload = {
    origin,
    associationId,
    entries,
  };
  return {
    payload: canonical,
    text: JSON.stringify({
      format: HANDOFF_RECORD_FORMAT,
      version: HANDOFF_RECORD_VERSION,
      origin: canonical.origin,
      associationId: canonical.associationId,
      entries: canonical.entries,
    }),
  };
}

function projectAcknowledgement(
  acknowledgement: TransferableAcknowledgement,
): TransferableAcknowledgement {
  const revision = requireExactParsed(
    acknowledgement.revision,
    createApplicationRevision,
    "revision",
  );
  switch (acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return {
        kind: acknowledgement.kind,
        revision,
        contentSha256: requireExactParsed(
          acknowledgement.contentSha256,
          createContentSha256,
          "content hash",
        ),
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return {
        kind: acknowledgement.kind,
        revision,
        recoveryId: requireExactParsed(
          acknowledgement.recoveryId,
          createRecoverySnapshotId,
          "recovery ID",
        ),
      };
  }
}

function convertRecord(dto: HandoffRecordDto): HandoffRecord {
  const origin = requireParsed(dto.origin, parsePersistedMirrorOrigin);
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const checksum = requireParsed(dto.checksum, createContentSha256);
  return {
    origin,
    associationId,
    entries: dto.entries.map(convertEntry),
    checksum,
  };
}

function convertEntry(
  dto: HandoffRecordDto["entries"][number],
): HandoffBaselineEntry {
  return {
    path: requireParsed(dto.path, normalizeNotePath),
    acknowledgement: convertAcknowledgement(dto.acknowledgement),
  };
}

function convertAcknowledgement(
  dto: TransferableAcknowledgementDto,
): TransferableAcknowledgement {
  const revision = requireParsed(dto.revision, createApplicationRevision);
  if (dto.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return {
      kind: dto.kind,
      revision,
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    };
  }
  return {
    kind: dto.kind,
    revision,
    recoveryId: requireParsed(dto.recoveryId, createRecoverySnapshotId),
  };
}

function requireParsed<Value>(
  value: string,
  parser: (candidate: string) => Value | undefined,
): Value {
  const parsed = parser(value);
  if (parsed === undefined) throw new Error("Invalid handoff identifier.");
  return parsed;
}

function requireExactParsed<Value extends string>(
  value: Value,
  parser: (candidate: string) => Value | undefined,
  field: string,
): Value {
  const parsed = parser(value);
  if (parsed === undefined || parsed !== value) {
    throw new Error(`Invalid handoff ${field}.`);
  }
  return parsed;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
