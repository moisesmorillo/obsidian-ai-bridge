import {
  MAX_SYNC_DEMO_PATHS,
  SYNC_DEMO_PARTICIPANT_COUNT,
  syncDemoClientPathSchema,
  syncDemoParticipantSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { z } from "zod";

/** Exact arming, namespace and participants for the isolated synthetic lab, never deployment configuration. */
const configurationSchema = z
  .object({
    mode: z.literal("synthetic-local-only"),
    vaultId: syncVaultIdSchema,
    paths: z.array(syncDemoClientPathSchema).min(1).max(MAX_SYNC_DEMO_PATHS),
    participants: z
      .array(syncDemoParticipantSchema)
      .length(SYNC_DEMO_PARTICIPANT_COUNT),
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.paths.map((path) => path.toLowerCase())).size ===
        config.paths.length &&
      new Set(config.participants.map((participant) => participant.clientId))
        .size === SYNC_DEMO_PARTICIPANT_COUNT &&
      new Set(config.participants.map((participant) => participant.origin))
        .size === SYNC_DEMO_PARTICIPANT_COUNT,
  );

/** Validated lab authority; no caller request can select a different vault or participant origin. */
export type SyncDemoConfiguration = z.infer<typeof configurationSchema>;

/** Validates the complete confidential local configuration; malformed or absent arming never enables routes.
 * @param serialized Untrusted lab JSON, distinct from production configuration.
 * @returns Fully validated authority or null, never partially accepted fields.
 */
export function decodeSyncDemoConfiguration(
  serialized: string | undefined,
): SyncDemoConfiguration | null {
  if (!serialized) return null;
  try {
    const result = configurationSchema.safeParse(JSON.parse(serialized));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
