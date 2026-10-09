import {
  MIRROR_MEDIA_TYPE,
  SYNC_REMOTE_CALLS,
  SYNC_REMOTE_PUT_BYTES,
  syncRemoteTicketSchema,
} from "@obsidian-ai-bridge/protocol";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import {
  R2_ABSENCE_WILDCARD,
  R2_IF_NONE_MATCH_HEADER,
} from "@worker/infrastructure/storage-object.constants";
import type { RemoteConfiguration } from "@worker/remote/remote-configuration";

/** Creates a request-scoped physical binding ceiling; failed attempts never refund calls or submitted bytes.
 * @param bucket Dedicated disposable binding; no release/local fallback.
 * @returns Conditional capability reserving every attempt before dispatch.
 * @throws RangeError Before a call would exceed its call or submitted-byte ceiling.
 */
export function cappedRemoteBucket(
  bucket: R2ConditionalBucketPort,
): R2ConditionalBucketPort {
  let calls = 0;
  let bytes = 0;
  /** Reserves both limits before any external call; failure cannot become an optimistic effect receipt.
   * @param size Submitted PUT bytes measured as UTF-8 or byte array length; zero for reads/list.
   */
  function reserve(size = 0): void {
    if (calls >= SYNC_REMOTE_CALLS || bytes + size > SYNC_REMOTE_PUT_BYTES)
      throw new RangeError("Remote lab budget exhausted.");
    ++calls;
    bytes += size;
  }
  return {
    get: async (key) => {
      reserve();
      return bucket.get(key);
    },
    list: async (options) => {
      reserve();
      return bucket.list(options);
    },
    put: async (key, content, options) => {
      reserve(
        typeof content === "string"
          ? new TextEncoder().encode(content).byteLength
          : content.byteLength,
      );
      return bucket.put(key, content, options);
    },
  };
}
/** Consumes exactly one participant-local transport slot before store dispatch; unavailable/lost claims never authorize work.
 * @param bucket Request-scoped capped conditional capability.
 * @param configuration Original server-selected experiment and vault authority.
 * @param origin Authenticated server-bound participant, never supplied authority from note text.
 * @param ticket Canonical participant-local slot header, not the store operation ID.
 * @returns True only for this attempt's matching native create-only receipt; false retains consumption/uncertainty without store authority.
 */
export async function claimRemoteTicket(
  bucket: R2ConditionalBucketPort,
  configuration: RemoteConfiguration,
  origin: string,
  ticket: string | undefined,
): Promise<boolean> {
  const parsed = syncRemoteTicketSchema.safeParse(ticket);
  if (
    !parsed.success ||
    !configuration.participants.some(
      (participant) => participant.origin === origin,
    )
  )
    return false;
  const key = `remote-lab/${configuration.experimentId}/${configuration.vaultId}/${origin}/${parsed.data}`;
  try {
    const created = await bucket.put(key, "claimed", {
      onlyIf: new Headers({ [R2_IF_NONE_MATCH_HEADER]: R2_ABSENCE_WILDCARD }),
      customMetadata: {},
      httpMetadata: { contentType: MIRROR_MEDIA_TYPE.plainText },
    });
    return created !== null && created.key === key;
  } catch {
    return false;
  }
}
