import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import { MIRROR_MEDIA_TYPE } from "@obsidian-ai-bridge/protocol";

/** Maximum bounded JSON metadata/acknowledgement response body size. */
export const MAX_REMOTE_METADATA_RESPONSE_BYTES = 512 * 1024;

/** Full Fetch operation deadline, including bounded response-body consumption. */
export const REMOTE_REQUEST_DEADLINE_MILLISECONDS = 30_000;

/** Exact Fetch options required by the no-cookie, no-redirect transport contract. */
export const REMOTE_FETCH_OPTIONS = {
  credentials: "omit",
  redirect: "error",
} as const;

/** Content type used for content-bearing v2 conditional note mutations. */
export const REMOTE_NOTE_REQUEST_CONTENT_TYPE = MIRROR_MEDIA_TYPE.markdownUtf8;

/** Raw note/recovery content shares the canonical 1 MiB protocol text bound. */
export const MAX_REMOTE_CONTENT_RESPONSE_BYTES = MAX_NOTE_SIZE_BYTES;
