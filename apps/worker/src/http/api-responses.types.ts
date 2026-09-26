import type {
  CurrentNoteState,
  MutationAcknowledgement,
  NotePage,
  RecoveryPage,
  RecoverySnapshotState,
} from "@obsidian-ai-bridge/core";
import type {
  ApiErrorResponse,
  MirrorDescriptionDto,
  NoteListResponse,
  NotePageDto,
  NoteWriteResponse,
  RecoveryPageDto,
  TombstoneMutationResponseDto,
} from "@obsidian-ai-bridge/protocol";

/** JSON response bodies serialized by the Worker transport. */
export type JsonResponseBody =
  | ApiErrorResponse
  | CurrentNoteState
  | MirrorDescriptionDto
  | MutationAcknowledgement
  | NoteListResponse
  | NotePage
  | NotePageDto
  | NoteWriteResponse
  | RecoveryPage
  | RecoveryPageDto
  | RecoverySnapshotState
  | TombstoneMutationResponseDto;
