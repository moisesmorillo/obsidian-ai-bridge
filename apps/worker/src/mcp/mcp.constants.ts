import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import { HTTP_METHOD } from "@obsidian-ai-bridge/protocol";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import type { ClientPermission } from "@worker/auth/auth.types";

/** Single authenticated Worker route that carries stateless MCP Streamable HTTP. */
export const MCP_ENDPOINT_PATH = "/mcp";

/** MCP-only transport headers not shared with the existing public v2 protocol. */
export const MCP_HTTP_HEADER = {
  allow: "Allow",
  cookie: "Cookie",
} as const;

/** Current MCP protocol revision pinned by the stateless Worker adapter. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** HTTP methods accepted and advertised by the one MCP endpoint. */
export const MCP_HTTP_METHOD = {
  post: HTTP_METHOD.post,
} as const;

/** HTTP method-not-allowed status for rejected MCP session and stream verbs. */
export const MCP_METHOD_NOT_ALLOWED_STATUS = 405;

/** Stable server identity advertised by MCP discovery. */
export const MCP_SERVER_IMPLEMENTATION = {
  name: "obsidian-ai-bridge",
  version: "1.0.2",
} as const;

/** Protocol capability names registered by the MCP adapter. */
export const MCP_OPERATION = {
  listNotes: "list_notes",
  inspectNote: "inspect_note",
  writeNote: "write_note",
  deleteNote: "delete_note",
  listRecovery: "list_recovery",
  inspectRecovery: "inspect_recovery",
  sealRecovery: "seal_recovery",
  purgeRecovery: "purge_recovery",
  noteContent: "note_content",
  recoveryContent: "recovery_content",
} as const;

/** Closed names for each application-backed MCP operation. */
export type McpOperation = (typeof MCP_OPERATION)[keyof typeof MCP_OPERATION];

/** MCP tool names derived from the shared operation identifiers. */
export const MCP_TOOL_NAME = {
  listNotes: MCP_OPERATION.listNotes,
  inspectNote: MCP_OPERATION.inspectNote,
  writeNote: MCP_OPERATION.writeNote,
  deleteNote: MCP_OPERATION.deleteNote,
  listRecovery: MCP_OPERATION.listRecovery,
  inspectRecovery: MCP_OPERATION.inspectRecovery,
  sealRecovery: MCP_OPERATION.sealRecovery,
  purgeRecovery: MCP_OPERATION.purgeRecovery,
} as const;

/** Dynamic-resource names derived from the same operation permission table. */
export const MCP_RESOURCE_TEMPLATE_NAME = {
  note: MCP_OPERATION.noteContent,
  recovery: MCP_OPERATION.recoveryContent,
} as const;

/** One exact M5 permission is authoritative for every MCP data/effect capability. */
export const MCP_OPERATION_PERMISSION = {
  [MCP_OPERATION.listNotes]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.inspectNote]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.noteContent]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.listRecovery]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.inspectRecovery]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.recoveryContent]: CLIENT_PERMISSION.read,
  [MCP_OPERATION.writeNote]: CLIENT_PERMISSION.write,
  [MCP_OPERATION.sealRecovery]: CLIENT_PERMISSION.write,
  [MCP_OPERATION.deleteNote]: CLIENT_PERMISSION.delete,
  [MCP_OPERATION.purgeRecovery]: CLIENT_PERMISSION.delete,
} as const satisfies Record<McpOperation, ClientPermission>;

/** Canonical authorities separating current-note and recovery resource identifiers. */
export const MCP_RESOURCE_AUTHORITY = {
  note: "note",
  recovery: "recovery",
} as const;

/** Closed inspection states for an explicitly requested recovery identity. */
export const MCP_RECOVERY_INSPECTION_KIND = {
  found: "found",
  missing: "missing",
} as const;

/** Canonical custom URI scheme used only for bounded note and recovery resources. */
export const MCP_RESOURCE_URI_SCHEME = "obsidian-ai-bridge";

/** Canonical note-resource URI template with an encoded NotePath segment. */
export const MCP_NOTE_RESOURCE_TEMPLATE_URI =
  `${MCP_RESOURCE_URI_SCHEME}://${MCP_RESOURCE_AUTHORITY.note}/{encodedPath}` as const;

/** Canonical recovery-resource URI template with one recovery identity segment. */
export const MCP_RECOVERY_RESOURCE_TEMPLATE_URI =
  `${MCP_RESOURCE_URI_SCHEME}://${MCP_RESOURCE_AUTHORITY.recovery}/{id}` as const;

/** Maximum JSON request bytes for one maximally escaped bounded note plus protocol overhead. */
export const MCP_MAX_REQUEST_BODY_BYTES = MAX_NOTE_SIZE_BYTES * 6 + 16 * 1024;

/** Maximum serialized response bytes for one bounded content result or one metadata page. */
export const MCP_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

/** Maximum stream chunks consumed to bound framing overhead and empty-chunk abuse. */
export const MCP_MAX_STREAM_CHUNKS = 16_384;

/** Implementation-defined JSON-RPC error used only for application permission refusal. */
export const MCP_SERVER_ERROR_CODE = {
  permissionDenied: -32000,
  internalError: -32603,
} as const;

/** Closed application-level failures mapped to static, content-free tool messages. */
export const MCP_TOOL_FAILURE = {
  permissionDenied: "permission_denied",
  staleRevision: "stale_revision",
  invalidState: "invalid_state",
  unavailable: "unavailable",
  effectUncertain: "effect_uncertain",
} as const;

/** Closed safe failure categories exposed to MCP tool clients. */
export type McpToolFailure =
  (typeof MCP_TOOL_FAILURE)[keyof typeof MCP_TOOL_FAILURE];

/** Sanitized user-visible messages for known MCP application failures. */
export const MCP_TOOL_FAILURE_MESSAGE = {
  [MCP_TOOL_FAILURE.permissionDenied]:
    "The authenticated client lacks the permission required for this operation.",
  [MCP_TOOL_FAILURE.staleRevision]:
    "The target does not satisfy the supplied write precondition; no replacement was applied.",
  [MCP_TOOL_FAILURE.invalidState]:
    "The operation is not valid for the current state.",
  [MCP_TOOL_FAILURE.unavailable]: "The operation could not be completed.",
  [MCP_TOOL_FAILURE.effectUncertain]:
    "The mutation outcome could not be confirmed. Inspect current state before choosing a new operation identity.",
} as const satisfies Record<
  (typeof MCP_TOOL_FAILURE)[keyof typeof MCP_TOOL_FAILURE],
  string
>;
