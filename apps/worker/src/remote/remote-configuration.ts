import {
  isSyncRemoteEndpoint,
  SYNC_REMOTE_LIFETIME_MS,
  SYNC_REMOTE_MODE,
  syncOperationIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { decodeSyncDemoConfiguration } from "@worker/demo/demo-configuration";
import { z } from "zod";

/** Explicit remote arming; the nested local authority is revalidated without granting local exposure. */
const remoteSchema = z
  .object({
    mode: z.literal(SYNC_REMOTE_MODE),
    endpoint: z.string().refine(isSyncRemoteEndpoint),
    experimentId: syncOperationIdSchema,
    enabled: z.boolean(),
    startsAtEpochMs: z.number().int().nonnegative(),
    expiresAtEpochMs: z.number().int().nonnegative(),
    vaultId: z.string(),
    paths: z.array(z.string()),
    participants: z.array(
      z.object({ clientId: z.string(), origin: z.string() }).strict(),
    ),
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAtEpochMs > value.startsAtEpochMs &&
      value.expiresAtEpochMs - value.startsAtEpochMs <= SYNC_REMOTE_LIFETIME_MS,
  );
/** Converts untrusted secret JSON to complete remote and existing strict namespace authority; never repairs it.
 * @param serialized Dedicated lab secret, not an ambient configuration or registry.
 * @returns Exact remote authority or null when missing, malformed or outside the one-hour contract.
 */
export function decodeRemoteConfiguration(serialized: string | undefined) {
  if (!serialized) return null;
  try {
    const parsed = remoteSchema.safeParse(JSON.parse(serialized));
    if (!parsed.success) return null;
    const {
      mode: _mode,
      endpoint,
      experimentId,
      enabled,
      startsAtEpochMs,
      expiresAtEpochMs,
      ...scope
    } = parsed.data;
    const local = decodeSyncDemoConfiguration(
      JSON.stringify({ ...scope, mode: "synthetic-local-only" }),
    );
    return local
      ? {
          ...local,
          endpoint,
          experimentId,
          enabled,
          startsAtEpochMs,
          expiresAtEpochMs,
        }
      : null;
  } catch {
    return null;
  }
}
/** Fully validated remote authority; only the server selects the namespace and participant. */
export type RemoteConfiguration = NonNullable<
  ReturnType<typeof decodeRemoteConfiguration>
>;
