import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";

/** Maximum bounded JSON metadata/acknowledgement response body size. */
export const MAX_REMOTE_METADATA_RESPONSE_BYTES = 512 * 1024;

/** Full Fetch operation deadline, including bounded response-body consumption. */
export const REMOTE_REQUEST_DEADLINE_MILLISECONDS = 30_000;

/** Worker v2 root path. */
export const REMOTE_API_V2_PATH = "/api/v2";

/** Exact Fetch options required by the no-cookie, no-redirect transport contract. */
export const REMOTE_FETCH_OPTIONS = {
  credentials: "omit",
  redirect: "error",
} as const;

/** Response media types accepted by the Worker v2 protocol. */
export const REMOTE_RESPONSE_MEDIA_TYPE = {
  json: "application/json",
  markdown: "text/markdown",
} as const;

/** Content type used for content-bearing v2 conditional note mutations. */
export const REMOTE_NOTE_REQUEST_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** Raw note/recovery content shares the canonical 1 MiB protocol text bound. */
export const MAX_REMOTE_CONTENT_RESPONSE_BYTES = MAX_NOTE_SIZE_BYTES;
