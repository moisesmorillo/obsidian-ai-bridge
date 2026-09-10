import type {
  ApiErrorResponse,
  HealthResponse,
  NoteListResponse,
  NoteWriteResponse,
} from "@obsidian-ai-bridge/protocol";

/** JSON response bodies serialized by the Worker transport. */
export type JsonResponseBody =
  | ApiErrorResponse
  | HealthResponse
  | NoteListResponse
  | NoteWriteResponse;
