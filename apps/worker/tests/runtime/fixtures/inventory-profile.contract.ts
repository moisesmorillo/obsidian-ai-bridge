import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION,
  SYNC_FEED_LANE_COUNT,
} from "@protocol/sync.constants";
import {
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import { z } from "zod";

/** Isolated deterministic identities; each run owns a separate persisted emulator directory. */
export const PROFILE_IDS = {
  vaultId: syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  inventoryId: syncInventoryIdSchema.parse(
    "22222222-2222-4222-8222-222222222222",
  ),
};
/** Fixture-only head batch size; not a production invocation reservation. */
export const PROFILE_SEED_BATCH = 32;
/** Synthetic CPU admission estimate; explicitly not a measured Free CPU budget. */
export const PROFILE_CPU_ALLOWANCE_MS = 20;
/** Largest admitted synthetic head population, sourced from the private codec. */
export const profileCountSchema = z
  .number()
  .int()
  .min(0)
  .max(SYNC_RECORD_LIMITS.inventoryHeads);
/** Safe epoch floors must be classified before aggregation. */
const epochSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Rehydrates the digest only after exact lowercase hexadecimal validation. */
const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .transform((value) => {
    const digest = createContentSha256(value);
    if (digest === undefined) throw new RangeError("Invalid fixture digest.");
    return digest;
  });
/** Exact complete handle forwarded to the real evidence verifier, never invented by the driver. */
export const profileHandleSchema = z
  .object({
    kind: z.literal("complete"),
    vaultId: syncVaultIdSchema,
    inventoryId: syncInventoryIdSchema,
    vector: z.array(syncSequenceSchema).length(SYNC_FEED_LANE_COUNT),
    entryCount: profileCountSchema,
    chunkCount: z.number().int().min(1).max(SYNC_RECORD_LIMITS.inventorySteps),
    root: digestSchema,
  })
  .strict();
/** Real-time progress carries the same scan identity and optional earliest safe retry. */
const progressSchema = z
  .object({
    kind: z.literal("inventory_in_progress"),
    vaultId: syncVaultIdSchema,
    inventoryId: syncInventoryIdSchema,
    retryAfterEpochMs: epochSchema.optional(),
  })
  .strict();
/** Bounded synthetic evidence summaries are validated before host checkpoint updates. */
const summariesSchema = z
  .array(
    z
      .object({
        path: syncNotePathSchema,
        kind: z.enum(["live", "tombstone"]),
        revision: syncRevisionSchema,
      })
      .strict(),
  )
  .max(16);
/** Actual evidence result retains the distinction between progress and root-verified completion. */
const pageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      summaries: summariesSchema,
      nextCursor: z.string().min(1),
      final: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
      summaries: summariesSchema,
      nextCursor: z.null(),
      final: z.literal(true),
    })
    .strict(),
]);
/** Private test entry permits only one operation per Worker request. */
export const profileRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("seed"),
      headCount: profileCountSchema,
      offset: profileCountSchema,
    })
    .strict()
    .refine((input) => input.offset <= input.headCount),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("continue") }).strict(),
  z
    .object({
      action: z.literal("page"),
      handle: profileHandleSchema,
      cursor: z.string(),
    })
    .strict(),
]);
/** Physical attempted binding calls and body bytes, measured inside this request only. */
export const profileMetricsSchema = z
  .object({
    calls: z
      .object({
        get: z.number().int().min(0),
        list: z.number().int().min(0),
        put: z.number().int().min(0),
      })
      .strict(),
    readBytes: z.number().int().min(0),
    writtenBytes: z.number().int().min(0),
    wallMs: z.number().min(0),
    cpu: z.literal("unavailable"),
    memory: z.literal("unavailable"),
    clock: z.literal("real"),
    preflightCpuAllowanceMs: z.literal(PROFILE_CPU_ALLOWANCE_MS),
  })
  .strict()
  .refine(
    (metrics) =>
      metrics.calls.get + metrics.calls.list + metrics.calls.put <=
      MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION,
  );
/** Refusals never masquerade as progress or completion, even if their persistence is uncertain. */
export const profileReplySchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("seed"),
      nextOffset: profileCountSchema,
      maxHeadBytes: z.number().int().min(0).max(SYNC_RECORD_LIMITS.headBytes),
      metrics: profileMetricsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("inventory"),
      result: z.union([profileHandleSchema, progressSchema]),
      metrics: profileMetricsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("page"),
      result: pageSchema,
      metrics: profileMetricsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("failed"),
      retryAfterEpochMs: epochSchema.optional(),
      metrics: profileMetricsSchema,
    })
    .strict(),
]);
/** Validated private request passed to the local Worker only. */
export type ProfileRequest = z.infer<typeof profileRequestSchema>;
/** Typed, observed response; external JSON cannot flow into the driver without parsing. */
export type ProfileReply = z.infer<typeof profileReplySchema>;
/** Crash checkpoint; replaying the last request is safe only with the same emulator and recipe. */
export const profileStateSchema = z
  .object({
    headCount: profileCountSchema,
    phase: z.enum(["seed", "start", "scan", "page", "done"]),
    offset: profileCountSchema,
    handle: profileHandleSchema.nullable(),
    cursor: z.string(),
    seen: z.array(profileCountSchema),
    notBeforeMs: epochSchema,
    startedAtMs: epochSchema,
    scanStartedAtMs: epochSchema.nullable(),
    maxHeadBytes: z.number().int().min(0).max(SYNC_RECORD_LIMITS.headBytes),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.offset > state.headCount ||
      new Set(state.seen).size !== state.seen.length ||
      state.seen.some((index) => index >= state.headCount) ||
      ((state.phase === "page" || state.phase === "done") &&
        state.handle === null) ||
      (state.phase === "done" && state.seen.length !== state.headCount)
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent profile checkpoint.",
      });
  });
/** Strong host checkpoint rehydrated immediately from local persisted JSON. */
export type ProfileState = z.infer<typeof profileStateSchema>;
