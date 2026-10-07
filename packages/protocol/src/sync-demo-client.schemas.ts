import {
  type ContentSha256,
  isReconciliationPreservationNamespacePath,
  type SyncDemoLedger,
} from "@obsidian-ai-bridge/core";
import { contentSha256Schema } from "@protocol/mirror.schemas";
import { decodeSyncCursor } from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncOpaqueCursorSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import { MAX_SYNC_DEMO_PATHS } from "@protocol/sync-demo.constants";
import { z } from "zod";

/** Explicit ASCII synthetic path admission; conflict namespaces cannot acquire sync authority. */
export const syncDemoClientPathSchema = syncNotePathSchema.refine(
  (path) =>
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/.test(path) &&
    !isReconciliationPreservationNamespacePath(path),
);
/** Brands only validated 64-character lowercase SHA-256 boundary values, without normalization. */
const hashSchema = contentSha256Schema.transform(
  (digest): ContentSha256 => digest as ContentSha256,
);
/** Immutable generation/hash pair, never arbitrary client metadata. */
const baseSchema = z
  .object({ revision: syncRevisionSchema, contentSha256: hashSchema })
  .strict();
/** Original conditional parent, retained without normalization or latest-head inference. */
const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never_seen") }).strict(),
  z
    .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
    .strict(),
]);
/** Exclusive content-free request, local-effect or competing-copy authority. */
const workSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("push"),
      certainty: z.enum(["uncertain", "not_admitted"]),
      operationId: syncOperationIdSchema,
      revision: syncRevisionSchema,
      parent: parentSchema,
      contentSha256: hashSchema,
      retryAfterEpochMs: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply"),
      target: baseSchema,
      expectedHash: hashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conflict"),
      target: baseSchema,
      preserved: z.boolean(),
    })
    .strict(),
]);
/** Cross-field checking binds prepared actions to the exact acknowledged base; checking never selects a policy. */
const entrySchema = z
  .object({
    path: syncDemoClientPathSchema,
    base: baseSchema.nullable(),
    work: workSchema.nullable(),
  })
  .strict()
  .refine((entry) => {
    if (entry.work?.kind === "apply")
      return (
        entry.work.expectedHash === (entry.base?.contentSha256 ?? null) &&
        entry.work.target.revision !== entry.base?.revision
      );
    if (entry.work?.kind !== "push") return true;
    return (
      entry.work.revision !== entry.base?.revision &&
      (entry.base === null
        ? entry.work.parent.kind === "never_seen"
        : entry.work.parent.kind === "revision" &&
          entry.work.parent.revision === entry.base.revision)
    );
  });
/** Strict experimental state rehydration: exact identities, bounded unique paths/requests and a vault-bound canonical cursor; no repair or bodies. */
export const syncDemoLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    vaultId: syncVaultIdSchema,
    deviceId: syncDeviceIdSchema,
    cursor: syncOpaqueCursorSchema,
    entries: z.array(entrySchema).min(1).max(MAX_SYNC_DEMO_PATHS),
  })
  .strict()
  .refine((ledger) => {
    const pushes = ledger.entries.flatMap((entry) =>
      entry.work?.kind === "push" ? [entry.work] : [],
    );
    return (
      decodeSyncCursor(ledger.cursor, ledger.vaultId) !== undefined &&
      new Set(ledger.entries.map((entry) => entry.path.toLowerCase())).size ===
        ledger.entries.length &&
      new Set(pushes.map((push) => push.operationId)).size === pushes.length &&
      new Set(pushes.map((push) => push.revision)).size === pushes.length
    );
  })
  .transform((ledger): SyncDemoLedger => ledger);
